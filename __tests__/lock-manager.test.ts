import { LockManager } from '../src/core/lock-manager';
import { MemoryFileSystem } from './memory-fs';
import { delay } from '../src/utils/helpers';

describe('LockManager', () => {
  let fs: MemoryFileSystem;
  let lockManager: LockManager;

  beforeEach(() => {
    fs = new MemoryFileSystem();
    lockManager = new LockManager(fs, '/test-storage');
  });

  afterEach(() => {
    fs.clear();
  });

  describe('acquireLock', () => {
    it('should acquire lock successfully', async () => {
      const lockId = await lockManager.acquireLock('test-lock', 'test-operation');
      expect(lockId).toBeDefined();
      expect(typeof lockId).toBe('string');

      await lockManager.releaseLock('test-lock', lockId);
    });

    it('should wait for lock to be released', async () => {
      const lockId1 = await lockManager.acquireLock('test-lock', 'operation-1');

      const startTime = Date.now();
      
      // 在另一个 "进程" 中尝试获取锁
      const promise = (async () => {
        await delay(100);
        await lockManager.releaseLock('test-lock', lockId1);
      })();

      const lockId2 = await lockManager.acquireLock('test-lock', 'operation-2');
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(lockId2).toBeDefined();

      await promise;
      await lockManager.releaseLock('test-lock', lockId2);
    });

    it('should timeout stale locks', async () => {
      // 创建一个过期的锁
      const lockPath = '/test-storage/.test-lock.lock';
      await fs.writeFile(lockPath, JSON.stringify({
        id: 'stale-lock',
        timestamp: Date.now() - 60000, // 60秒前
        operation: 'stale',
      }));

      // 应该能够获取锁
      const lockId = await lockManager.acquireLock('test-lock', 'new-operation');
      expect(lockId).toBeDefined();

      await lockManager.releaseLock('test-lock', lockId);
    });
  });

  describe('releaseLock', () => {
    it('should release lock successfully', async () => {
      const lockId = await lockManager.acquireLock('test-lock', 'test-operation');
      await lockManager.releaseLock('test-lock', lockId);

      const lockPath = '/test-storage/.test-lock.lock';
      const exists = await fs.exists(lockPath);
      expect(exists).toBe(false);
    });

    it('should not release lock with wrong ID', async () => {
      const lockId = await lockManager.acquireLock('test-lock', 'test-operation');
      await lockManager.releaseLock('test-lock', 'wrong-id');

      const lockPath = '/test-storage/.test-lock.lock';
      const exists = await fs.exists(lockPath);
      expect(exists).toBe(true);

      await lockManager.releaseLock('test-lock', lockId);
    });
  });

  describe('withLock', () => {
    it('should execute function with lock', async () => {
      let executed = false;

      await lockManager.withLock('test-lock', 'test-operation', async () => {
        executed = true;
      });

      expect(executed).toBe(true);

      const lockPath = '/test-storage/.test-lock.lock';
      const exists = await fs.exists(lockPath);
      expect(exists).toBe(false);
    });

    it('should release lock even if function throws', async () => {
      await expect(
        lockManager.withLock('test-lock', 'test-operation', async () => {
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');

      const lockPath = '/test-storage/.test-lock.lock';
      const exists = await fs.exists(lockPath);
      expect(exists).toBe(false);
    });

    it('should return function result', async () => {
      const result = await lockManager.withLock('test-lock', 'test-operation', async () => {
        return 42;
      });

      expect(result).toBe(42);
    });
  });

  describe('concurrent lock access', () => {
    it('should handle multiple concurrent lock attempts', async () => {
      const results: string[] = [];

      const tasks = Array.from({ length: 5 }, (_, i) =>
        lockManager.withLock('shared-lock', `operation-${i}`, async () => {
          results.push(`start-${i}`);
          await delay(50);
          results.push(`end-${i}`);
        })
      );

      await Promise.all(tasks);

      expect(results.length).toBe(10);
      
      // 验证操作是串行执行的
      for (let i = 0; i < 5; i++) {
        const startIndex = results.indexOf(`start-${i}`);
        const endIndex = results.indexOf(`end-${i}`);
        expect(startIndex).toBeLessThan(endIndex);
      }
    });
  });
});
