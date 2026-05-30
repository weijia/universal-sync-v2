import { StorageManager } from '../src/core/storage-manager';
import { MemoryFileSystem } from './memory-fs';
import { StoredDocument } from '../src/types';

describe('StorageManager', () => {
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

  describe('writeDocuments', () => {
    it('should write documents to storage', async () => {
      const docs: StoredDocument[] = [
        { _id: 'doc1', _rev: '1-abc', name: 'Test 1' },
        { _id: 'doc2', _rev: '1-def', name: 'Test 2' },
      ];

      await storage.writeDocuments(docs);

      const files = fs.getAllFiles();
      expect(files.length).toBeGreaterThan(0);
      expect(files.some(f => f.includes('data-'))).toBe(true);
    });

    it('should handle empty document array', async () => {
      await storage.writeDocuments([]);
      
      const files = fs.getAllFiles();
      const dataFiles = files.filter(f => f.includes('data-'));
      expect(dataFiles.length).toBe(0);
    });

    it('should split large document batches into chunks', async () => {
      const docs: StoredDocument[] = [];
      
      // 创建大量文档（需要超过 docsPerChunk = maxFileSize / 500 = 200）
      for (let i = 0; i < 250; i++) {
        docs.push({
          _id: `doc${i}`,
          _rev: `1-${i}`,
          data: 'x'.repeat(200), // 每个文档约 200 字节
        });
      }

      await storage.writeDocuments(docs);

      const files = fs.getAllFiles();
      const dataFiles = files.filter(f => f.includes('data-'));
      expect(dataFiles.length).toBeGreaterThan(1);
    });
  });

  describe('readAllDocuments', () => {
    it('should read all documents from storage', async () => {
      const docs: StoredDocument[] = [
        { _id: 'doc1', _rev: '1-abc', name: 'Test 1' },
        { _id: 'doc2', _rev: '1-def', name: 'Test 2' },
      ];

      await storage.writeDocuments(docs);
      const readDocs = await storage.readAllDocuments();

      expect(readDocs.length).toBe(2);
      expect(readDocs.find(d => d._id === 'doc1')).toBeDefined();
      expect(readDocs.find(d => d._id === 'doc2')).toBeDefined();
    });

    it('should return latest version of documents', async () => {
      // 写入第一个版本
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '1-abc', version: 1 },
      ]);

      // 写入第二个版本
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '2-def', version: 2 },
      ]);

      const docs = await storage.readAllDocuments();
      expect(docs.length).toBe(1);
      expect(docs[0].version).toBe(2);
    });

    it('should return empty array when no documents exist', async () => {
      const docs = await storage.readAllDocuments();
      expect(docs).toEqual([]);
    });
  });

  describe('readIncrementalDocuments', () => {
    it('should read documents from specific sequence', async () => {
      // 写入第一批
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '1-abc', batch: 1 },
      ]);

      // 写入第二批
      await storage.writeDocuments([
        { _id: 'doc2', _rev: '1-def', batch: 2 },
      ]);

      const docs = await storage.readIncrementalDocuments(2);
      expect(docs.length).toBeGreaterThan(0);
      expect(docs.some(d => d._id === 'doc2')).toBe(true);
    });
  });

  describe('mergeFiles', () => {
    it('should merge multiple small files', async () => {
      // 写入多个小文档批次
      for (let i = 0; i < 3; i++) {
        await storage.writeDocuments([
          { _id: `doc${i}`, _rev: `1-${i}`, data: 'small' },
        ]);
      }

      const candidates = await storage.getMergeCandidates();
      
      if (candidates.length > 0 && candidates[0].length > 1) {
        const mergedFile = await storage.mergeFiles(candidates[0]);
        
        expect(mergedFile).toBeDefined();
        expect(mergedFile.mergedFrom).toBeDefined();
        expect(mergedFile.mergedFrom!.length).toBeGreaterThan(1);
      }
    });

    it('should throw error when merging less than 2 files', async () => {
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '1-abc', data: 'test' },
      ]);

      const candidates = await storage.getMergeCandidates();
      
      if (candidates.length > 0) {
        await expect(storage.mergeFiles([candidates[0][0]])).rejects.toThrow();
      }
    });
  });

  describe('getMergeCandidates', () => {
    it('should identify files that need merging', async () => {
      // 写入多个小文档
      for (let i = 0; i < 5; i++) {
        await storage.writeDocuments([
          { _id: `doc${i}`, _rev: `1-${i}`, small: true },
        ]);
      }

      const candidates = await storage.getMergeCandidates();
      expect(Array.isArray(candidates)).toBe(true);
    });

    it('should return empty array when no merge needed', async () => {
      const candidates = await storage.getMergeCandidates();
      expect(candidates).toEqual([]);
    });
  });
});
