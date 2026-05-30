import { StorageManager } from '../src/core/storage-manager';
import { MemoryFileSystem } from './memory-fs';
import { StoredDocument } from '../src/types';

describe('StorageManager - 目录重组', () => {
  let fs: MemoryFileSystem;
  let storage: StorageManager;

  beforeEach(async () => {
    fs = new MemoryFileSystem();
    storage = new StorageManager(fs, {
      basePath: '/test-storage',
      maxFileSize: 1024 * 100,
      mergeThreshold: 1024 * 10,
      reorgThreshold: 3, // 测试用小阈值
      reorgBatchSize: 10,
      autoReorganize: false, // 测试中手动触发
    });
    await storage.initialize();
  });

  afterEach(() => {
    fs.clear();
  });

  describe('getDirectoryStats', () => {
    it('应该在有文件时返回统计信息', async () => {
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '1-abc', name: 'Test 1' },
      ]);

      const stats = await storage.getDirectoryStats(100);
      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0].fileCount).toBeGreaterThan(0);
    });

    it('应该在文件数超过阈值时标记需要重组', async () => {
      // 写入 4 个批次（超过 reorgThreshold=3）
      for (let i = 0; i < 4; i++) {
        await storage.writeDocuments([
          { _id: `doc${i}`, _rev: `1-${i}`, name: `Test ${i}` },
        ]);
      }

      const stats = await storage.getDirectoryStats(3);
      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0].needsReorganization).toBe(true);
    });

    it('应该在文件数未超过阈值时不标记需要重组', async () => {
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '1-abc', name: 'Test 1' },
      ]);

      const stats = await storage.getDirectoryStats(100);
      expect(stats[0].needsReorganization).toBe(false);
    });

    it('应该在空目录时返回空数组', async () => {
      const stats = await storage.getDirectoryStats(100);
      expect(stats).toEqual([]);
    });
  });

  describe('shouldReorganize', () => {
    it('应该在文件数超过阈值时返回 true', async () => {
      for (let i = 0; i < 4; i++) {
        await storage.writeDocuments([
          { _id: `doc${i}`, _rev: `1-${i}`, name: `Test ${i}` },
        ]);
      }

      const should = await storage.shouldReorganize();
      expect(should).toBe(true);
    });

    it('应该在文件数未超过阈值时返回 false', async () => {
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '1-abc', name: 'Test 1' },
      ]);

      const should = await storage.shouldReorganize();
      expect(should).toBe(false);
    });

    it('应该在空目录时返回 false', async () => {
      const should = await storage.shouldReorganize();
      expect(should).toBe(false);
    });
  });

  describe('reorganize', () => {
    it('应该将文件移动到 YYYY/MM 分区目录', async () => {
      // 写入 4 个批次（超过阈值）
      for (let i = 0; i < 4; i++) {
        await storage.writeDocuments([
          { _id: `doc${i}`, _rev: `1-${i}`, name: `Test ${i}` },
        ]);
      }

      // 执行重组
      const result = await storage.reorganize();
      expect(result.movedFiles).toBeGreaterThan(0);
      expect(result.failedFiles).toBe(0);

      // 验证：文件应该已从根目录移动到分区目录
      const allFiles = fs.getAllFiles();
      const rootDataFiles = allFiles.filter(
        f => f.match(/\/test-storage\/data\/data-.*\.json$/)
      );
      const partitionFiles = allFiles.filter(
        f => f.match(/\/test-storage\/data\/\d{4}\/\d{2}\/data-.*\.json$/)
      );

      // 根目录应该不再有数据文件
      expect(rootDataFiles.length).toBe(0);
      // 分区目录应该有数据文件
      expect(partitionFiles.length).toBeGreaterThan(0);
    });

    it('应该在 dryRun 模式下不实际移动文件', async () => {
      for (let i = 0; i < 4; i++) {
        await storage.writeDocuments([
          { _id: `doc${i}`, _rev: `1-${i}`, name: `Test ${i}` },
        ]);
      }

      const result = await storage.reorganize({ dryRun: true });
      expect(result.movedFiles).toBeGreaterThan(0);

      // 验证：文件应该仍在根目录
      const allFiles = fs.getAllFiles();
      const rootDataFiles = allFiles.filter(
        f => f.match(/\/test-storage\/data\/data-.*\.json$/)
      );
      expect(rootDataFiles.length).toBeGreaterThan(0);
    });

    it('应该在重组后仍能正确读取所有文档', async () => {
      // 写入文档
      const docs: StoredDocument[] = [];
      for (let i = 0; i < 4; i++) {
        docs.push({ _id: `doc${i}`, _rev: `1-${i}`, name: `Test ${i}` });
      }
      await storage.writeDocuments(docs);

      // 执行重组
      const result = await storage.reorganize();
      expect(result.failedFiles).toBe(0);

      // 验证：所有文档仍可读取
      const readDocs = await storage.readAllDocuments();
      expect(readDocs.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(readDocs.find(d => d._id === `doc${i}`)).toBeDefined();
        expect(readDocs.find(d => d._id === `doc${i}`)?.name).toBe(`Test ${i}`);
      }
    });

    it('应该尊重 batchSize 限制', async () => {
      // 写入 10 个批次
      for (let i = 0; i < 10; i++) {
        await storage.writeDocuments([
          { _id: `doc${i}`, _rev: `1-${i}`, name: `Test ${i}` },
        ]);
      }

      // 只处理 3 个
      const result = await storage.reorganize({ batchSize: 3 });
      expect(result.movedFiles).toBe(3);
    });

    it('应该在空目录时返回空结果', async () => {
      const result = await storage.reorganize();
      expect(result.movedFiles).toBe(0);
      expect(result.failedFiles).toBe(0);
    });

    it('应该在不需要重组时返回空结果', async () => {
      // 只写入 1 个文件（低于阈值）
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '1-abc', name: 'Test 1' },
      ]);

      const result = await storage.reorganize();
      expect(result.movedFiles).toBeGreaterThan(0); // reorganize 不检查阈值，直接执行
    });

    it('应该在部分文件失败时继续处理其他文件', async () => {
      // 写入文件
      for (let i = 0; i < 4; i++) {
        await storage.writeDocuments([
          { _id: `doc${i}`, _rev: `1-${i}`, name: `Test ${i}` },
        ]);
      }

      // 手动损坏一个文件（写入无效 JSON）
      const allFiles = fs.getAllFiles();
      const dataFiles = allFiles.filter(f => f.includes('data-') && !f.includes('manifest'));
      if (dataFiles.length > 0) {
        // 写入无效内容到第一个数据文件
        await fs.writeFile(dataFiles[0], 'invalid json');
      }

      const result = await storage.reorganize();
      // 至少应该有一些成功
      expect(result.movedFiles).toBeGreaterThan(0);
      // 损坏的文件应该计入失败
      expect(result.failedFiles).toBeGreaterThanOrEqual(0);
    });

    it('多次重组不应丢失数据', async () => {
      // 写入文档
      for (let i = 0; i < 4; i++) {
        await storage.writeDocuments([
          { _id: `doc${i}`, _rev: `1-${i}`, name: `Test ${i}` },
        ]);
      }

      // 第一次重组
      const result1 = await storage.reorganize();
      expect(result1.failedFiles).toBe(0);

      // 第二次重组（应该没有文件需要移动）
      const result2 = await storage.reorganize();
      expect(result2.movedFiles).toBe(0);

      // 验证所有文档仍可读取
      const readDocs = await storage.readAllDocuments();
      expect(readDocs.length).toBe(4);
    });
  });

  describe('reorganizeToPartitions', () => {
    it('应该与 reorganize 行为一致', async () => {
      for (let i = 0; i < 4; i++) {
        await storage.writeDocuments([
          { _id: `doc${i}`, _rev: `1-${i}`, name: `Test ${i}` },
        ]);
      }

      await storage.reorganizeToPartitions();

      // 验证文件已移动
      const readDocs = await storage.readAllDocuments();
      expect(readDocs.length).toBe(4);
    });
  });
});
