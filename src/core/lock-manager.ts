import { IFileSystem, LockInfo } from '../types.js';
import { FileSystemUtils } from '../utils/fs-utils.js';
import { generateId, delay } from '../utils/helpers.js';

/**
 * 分布式锁管理器
 * 使用文件系统实现简单的分布式锁
 */
export class LockManager {
  private fsUtils: FileSystemUtils;
  // In-process active lock set to serialize lock creation within the same process
  private activeLocks = new Set<string>();
  private readonly lockTimeout = 30000; // 30秒锁超时
  private readonly retryDelay = 1000; // 1秒重试间隔
  private readonly maxRetries = 30; // 最多重试30次
  private readonly debug = process.env.NODE_ENV !== 'test'; // 测试环境不输出日志
  private readonly verificationDelay: number; // 验证延迟，根据文件系统类型自动调整

  constructor(
    private fs: IFileSystem,
    private basePath: string
  ) {
    this.fsUtils = new FileSystemUtils(fs);
    // 检查是否是内存文件系统（测试用），如果是则减少验证延迟
    this.verificationDelay = this.isMemoryFileSystem() ? 0 : 1000;
  }

  /**
   * 检查是否是内存文件系统（测试用）
   */
  private isMemoryFileSystem(): boolean {
    return this.fs.constructor.name === 'MemoryFileSystem';
  }

  /**
   * 日志输出
   */
  private log(message: string, ...args: any[]) {
    if (this.debug) {
      console.log(message, ...args);
    }
  }

  /**
   * 警告输出
   */
  private warn(message: string, ...args: any[]) {
    if (this.debug) {
      console.warn(message, ...args);
    }
  }

  /**
   * 错误输出
   */
  private error(message: string, ...args: any[]) {
    if (this.debug) {
      console.error(message, ...args);
    }
  }



  /**
   * 获取锁文件路径
   */
  private getLockPath(lockName: string): string {
    return this.fsUtils.joinPath(this.basePath, `.${lockName}.lock`);
  }

  /**
   * 尝试获取锁
   */
  async acquireLock(lockName: string, operation: string): Promise<string> {
    const lockPath = this.getLockPath(lockName);
    const lockId = generateId();
    
    for (let i = 0; i < this.maxRetries; i++) {
      this.log(`[Lock ${lockName}] Attempt ${i + 1}/${this.maxRetries}`);
      try {
        // 检查现有锁
        const exists = await this.fsUtils.fileExists(lockPath);
        this.log(`[Lock ${lockName}] Lock file exists: ${exists}`);
        
        if (exists) {
          // 读取现有锁信息
          try {
            const lockInfo = await this.fsUtils.readJSON<LockInfo>(lockPath);
            this.log(`[Lock ${lockName}] Existing lock info:`, lockInfo);
            const lockAge = Date.now() - lockInfo.timestamp;
            this.log(`[Lock ${lockName}] Lock age: ${lockAge}ms, timeout: ${this.lockTimeout}ms`);
            
            // 如果锁超时，删除它
            if (lockAge > this.lockTimeout) {
              this.log(`[Lock ${lockName}] Lock timed out, deleting...`);
              await this.fs.unlink(lockPath);
            } else {
              // 锁仍然有效，等待
              this.log(`[Lock ${lockName}] Lock still valid, waiting ${this.retryDelay}ms...`);
              await delay(this.retryDelay);
              continue;
            }
          } catch (parseError) {
            // JSON 解析失败，可能是文件损坏或正在写入，尝试删除并重试
            this.warn(`[Lock ${lockName}] Failed to parse lock file:`, parseError);
            try {
              await this.fs.unlink(lockPath);
            } catch {
              // 删除失败，继续等待
            }
            await delay(this.retryDelay);
            continue;
          }
        }
        
        // 尝试创建锁
        // 在同一进程内先抢占内存锁以避免并发写入导致的竞态
        if (this.activeLocks.has(lockPath)) {
          // 另一个协程正在创建同一把锁，等待并重试
          this.log(`[Lock ${lockName}] Another coroutine is creating this lock, waiting...`);
          await delay(this.retryDelay);
          continue;
        }
        this.activeLocks.add(lockPath);
        this.log(`[Lock ${lockName}] Creating lock with id: ${lockId}`);

        const lockInfo: LockInfo = {
          id: lockId,
          timestamp: Date.now(),
          operation,
        };
        
        await this.fsUtils.writeJSON(lockPath, lockInfo);
        this.log(`[Lock ${lockName}] Lock file written, waiting for WebDAV sync...`);
        
        // 验证锁是否成功创建（防止竞争条件）
        // 增加延迟以确保 WebDAV 服务器完成写入
        // 对于内存文件系统，延迟为 0，加速测试
        await delay(this.verificationDelay);
        
        try {
          const verifyLock = await this.fsUtils.readJSON<LockInfo>(lockPath);
          this.log(`[Lock ${lockName}] Verification read:`, verifyLock);
          
          if (verifyLock.id === lockId) {
            this.log(`[Lock ${lockName}] Lock acquired successfully!`);
            return lockId;
          }
          
          this.warn(`[Lock ${lockName}] Lock verification failed: expected ${lockId}, got ${verifyLock.id}, lockAge: ${Date.now() - verifyLock.timestamp}ms`);
        } catch (error) {
          // 验证失败，可能是 WebDAV 服务器还在处理写入，等待后重试
          this.warn(`[Lock ${lockName}] Lock verification error:`, error);
        } finally {
          // 释放进程内锁
          this.activeLocks.delete(lockPath);
        }
        
        // 锁被其他进程抢走或验证失败，重试
        this.log(`[Lock ${lockName}] Retrying in ${this.retryDelay}ms...`);
        await delay(this.retryDelay);
      } catch (error) {
        // 文件操作错误，重试
        this.error(`[Lock ${lockName}] Error during lock acquisition:`, error);
        await delay(this.retryDelay);
      }
    }
    
    throw new Error(`Failed to acquire lock '${lockName}' after ${this.maxRetries} retries`);
  }

  /**
   * 释放锁
   */
  async releaseLock(lockName: string, lockId: string): Promise<void> {
    const lockPath = this.getLockPath(lockName);
    
    try {
      // 验证锁所有权
      const lockInfo = await this.fsUtils.readJSON<LockInfo>(lockPath);
      
      if (lockInfo.id === lockId) {
        await this.fs.unlink(lockPath);
      }
    } catch (error) {
      // 锁文件可能已经不存在，忽略错误
    }
  }

  /**
   * 使用锁执行操作
   */
  async withLock<T>(
    lockName: string,
    operation: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const lockId = await this.acquireLock(lockName, operation);
    
    try {
      return await fn();
    } finally {
      await this.releaseLock(lockName, lockId);
    }
  }
}
