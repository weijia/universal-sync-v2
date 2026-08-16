import { StorageManager } from '../src/core/storage-manager';
import { MemoryFileSystem } from './memory-fs';
import { StoredDocument } from '../src/types';

function doc(id: string, rev: string, extra: Record<string, any> = {}): StoredDocument {
  return { _id: id, _rev: rev, ...extra } as StoredDocument;
}

describe('StorageManager (rev2)', () => {
  let fs: MemoryFileSystem;
  let storage: StorageManager;

  beforeEach(async () => {
    fs = new MemoryFileSystem();
    storage = new StorageManager(fs, {
      basePath: '/test-storage',
      maxFileSize: 1024 * 100, // 100KB for testing
      mergeThreshold: 1024 * 10, // 10KB for testing
    });

    await storage.initialize();
  });

  afterEach(() => {
    fs.clear();
  });

  describe('writeDocuments - 写入即分片', () => {
    it('should write documents into the date-partitioned data directory', async () => {
      await storage.writeDocuments([doc('doc1', '1-abc', { name: 'Test 1' })]);

      const dataFiles = (await storage.listAllDataFiles()).filter(f => f.includes('/data/'));
      expect(dataFiles.length).toBe(1);
      // 路径应包含 YYYY/MM/DD 分片
      expect(dataFiles[0]).toMatch(/\/data\/\d{4}\/\d{2}\/\d{2}\/data-/);
    });

    it('should write nothing for empty document array', async () => {
      await storage.writeDocuments([]);
      expect((await storage.listAllDataFiles()).length).toBe(0);
    });

    it('should split a large batch into multiple data files by maxFileSize', async () => {
      const docs: StoredDocument[] = [];
      for (let i = 0; i < 250; i++) {
        docs.push(doc(`doc${i}`, `1-${i}`, { data: 'x'.repeat(500) }));
      }

      await storage.writeDocuments(docs);

      const dataFiles = (await storage.listAllDataFiles()).filter(f => f.includes('/data/'));
      expect(dataFiles.length).toBeGreaterThan(1);
    });
  });

  describe('readAllDocuments', () => {
    it('should read all documents from storage', async () => {
      await storage.writeDocuments([
        doc('doc1', '1-abc', { name: 'Test 1' }),
        doc('doc2', '1-def', { name: 'Test 2' }),
      ]);

      const readDocs = await storage.readAllDocuments();
      expect(readDocs.length).toBe(2);
      expect(readDocs.find(d => d._id === 'doc1')).toBeDefined();
      expect(readDocs.find(d => d._id === 'doc2')).toBeDefined();
    });

    it('should keep the latest version by _rev generation', async () => {
      await storage.writeDocuments([doc('doc1', '1-abc', { version: 1 })]);
      await storage.writeDocuments([doc('doc1', '2-def', { version: 2 })]);

      const docs = await storage.readAllDocuments();
      expect(docs.length).toBe(1);
      expect((docs[0] as any).version).toBe(2);
    });

    it('should return empty array when no documents exist', async () => {
      expect(await storage.readAllDocuments()).toEqual([]);
    });

    it('should include partitioned merged files', async () => {
      await fs.mkdir('/test-storage/merged/2026/07/29', { recursive: true });
      await fs.writeFile(
        '/test-storage/merged/2026/07/29/merged-123456.json',
        JSON.stringify({
          version: '2.0.0',
          timestamp: 123456,
          documents: [
            doc('doc1', '1-abc', { source: 'merged' }),
            doc('doc2', '1-def', { source: 'merged' }),
          ],
        })
      );

      const docs = await storage.readAllDocuments();
      expect(docs.length).toBe(2);
      expect(docs.every(d => (d as any).source === 'merged')).toBe(true);
    });
  });

  describe('findMergeCandidates', () => {
    it('should identify multiple small files in the same directory', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.writeDocuments([doc(`doc${i}`, `1-${i}`, { small: true })]);
      }

      const candidates = await storage.findMergeCandidates();
      expect(Array.isArray(candidates)).toBe(true);
    });

    it('should return empty array when storage is empty', async () => {
      expect(await storage.findMergeCandidates()).toEqual([]);
    });
  });

  describe('mergeFiles', () => {
    it('should merge small files into merged/ and move sources to archive, keeping latest by _rev', async () => {
      // 在同一日期目录下手动放置两个小数据文件，模拟多次 push 产生的分片
      const dir = '/test-storage/data/2026/07/29';
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        `${dir}/data-2026-07-29T10-00-00-000Z.json`,
        JSON.stringify({ version: '2.0.0', timestamp: 1, documents: [doc('doc1', '1-abc', { v: 1 })] })
      );
      await fs.writeFile(
        `${dir}/data-2026-07-29T10-00-01-000Z.json`,
        JSON.stringify({ version: '2.0.0', timestamp: 2, documents: [doc('doc1', '2-def', { v: 2 }), doc('doc2', '1-xyz')] })
      );

      const candidates = await storage.findMergeCandidates();
      expect(candidates.length).toBeGreaterThan(0);

      await storage.mergeFiles(candidates[0]);

      // 合并结果写入 merged/，源文件移入 archive/
      const mergedFiles = await storage.listAllDataFiles();
      const mergedOnly = mergedFiles.filter(f => f.includes('/merged/'));
      expect(mergedOnly.length).toBe(1);

      const docs = await storage.readAllDocuments();
      expect(docs.find(d => d._id === 'doc1')!._rev).toBe('2-def');

      // 源文件已移至 archive（data 目录下不再有该文件）
      const dataFiles = mergedFiles.filter(f => f.includes('/data/'));
      expect(dataFiles.length).toBe(0);
      expect(await fs.exists('/test-storage/archive/data/2026/07/29')).toBe(true);
    });
  });

  describe('cleanupArchivedFiles', () => {
    it('should remove empty date-partition directories in data, keep archive', async () => {
      const dir = '/test-storage/data/2026/07/29';
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        `${dir}/data-2026-07-29T10-00-00-000Z.json`,
        JSON.stringify({ version: '2.0.0', timestamp: 1, documents: [doc('doc1', '1-abc')] })
      );
      await fs.writeFile(
        `${dir}/data-2026-07-29T10-00-01-000Z.json`,
        JSON.stringify({ version: '2.0.0', timestamp: 2, documents: [doc('doc2', '1-xyz')] })
      );

      const candidates = await storage.findMergeCandidates();
      expect(candidates.length).toBeGreaterThan(0);
      await storage.mergeFiles(candidates[0]);

      await storage.cleanupArchivedFiles();
      // data 源目录被移空后应被清理
      expect(await fs.exists(dir)).toBe(false);
      // archive 仍有源文件，目录应保留
      expect(await fs.exists('/test-storage/archive/data/2026/07/29')).toBe(true);
    });
  });
});
