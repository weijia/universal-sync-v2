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

  constructor(
    private fs: IFileSystem,
    private basePath: string
  ) {
    this.fsUtils = new FileSystemUtils(fs);
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
      try {
        // 检查现有锁
        const exists = await this.fsUtils.fileExists(lockPath);
        
        if (exists) {
          // 读取现有锁信息
          const lockInfo = await this.fsUtils.readJSON<LockInfo>(lockPath);
          const lockAge = Date.now() - lockInfo.timestamp;
          
          // 如果锁超时，删除它
          if (lockAge > this.lockTimeout) {
            await this.fs.unlink(lockPath);
          } else {
            // 锁仍然有效，等待
            await delay(this.retryDelay);
            continue;
          }
        }
        
        // 尝试创建锁
        // 在同一进程内先抢占内存锁以避免并发写入导致的竞态
        if (this.activeLocks.has(lockPath)) {
          // 另一个协程正在创建同一把锁，等待并重试
          await delay(this.retryDelay);
          continue;
        }
        this.activeLocks.add(lockPath);

        const lockInfo: LockInfo = {
          id: lockId,
          timestamp: Date.now(),
          operation,
        };
        
        await this.fsUtils.writeJSON(lockPath, lockInfo);
        
        // 验证锁是否成功创建（防止竞争条件）
        // 增加延迟以确保 WebDAV 服务器完成写入
        await delay(500);
        
        try {
          const verifyLock = await this.fsUtils.readJSON<LockInfo>(lockPath);
          
          if (verifyLock.id === lockId) {
            return lockId;
          }
          
          console.warn(`Lock verification failed: expected ${lockId}, got ${verifyLock.id}`);
        } catch (error) {
          console.error(`Failed to verify lock at ${lockPath}:`, error);
        } finally {
          // 释放进程内锁
          this.activeLocks.delete(lockPath);
        }
        
        // 锁被其他进程抢走或验证失败，重试
        await delay(this.retryDelay);
      } catch (error) {
        // 文件操作错误，重试
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
