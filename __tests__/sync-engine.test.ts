import { SyncEngine } from '../src/core/sync-engine';
import { StorageManager } from '../src/core/storage-manager';
import { MemoryFileSystem } from './memory-fs';
import PouchDB from 'pouchdb-core';
import { jest } from '@jest/globals';

// 尝试导入并注册内存适配器
let memoryAdapterLoaded = false;

// 使用动态导入加载内存适配器
import('pouchdb-adapter-memory').then((module) => {
  const PouchDBMemory = module.default || module;
  PouchDB.plugin(PouchDBMemory);
  memoryAdapterLoaded = true;
  console.log('Memory adapter loaded successfully');
}).catch((e) => {
  console.warn('Failed to load pouchdb-adapter-memory:', e);
});

describe('SyncEngine', () => {
  let fs: MemoryFileSystem;
  let db: PouchDB.Database;
  let syncEngine: SyncEngine;

  beforeEach(async () => {
    // 创建内存文件系统
    fs = new MemoryFileSystem();
    
    // 等待内存适配器加载（最多等待3秒）
    let waitTime = 0;
    while (!memoryAdapterLoaded && waitTime < 3000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waitTime += 100;
    }
    
    // 创建数据库（如果内存适配器加载成功，使用内存适配器；否则使用默认适配器）
    if (memoryAdapterLoaded) {
      console.log('Creating database with memory adapter');
      db = new PouchDB('test-db', { adapter: 'memory' });
    } else {
      console.log('Creating database with default adapter (memory adapter failed to load)');
      db = new PouchDB('test-db');
    }
    
    // 创建同步引擎
    syncEngine = new SyncEngine(db, fs, {
      basePath: '/test-sync',
      maxFileSize: 1024 * 100, // 100KB for testing
      mergeThreshold: 1024 * 10, // 10KB for testing
      autoMerge: false,
    });
    
    await syncEngine.initialize();
  });

  afterEach(async () => {
    // 清理数据库
    await db.destroy();
    // 清理文件系统
    fs.clear();
  });

  describe('sync', () => {
    it('should sync documents from PouchDB to storage', async () => {
      // 在数据库中添加文档
      await db.put({ _id: 'doc1', name: 'Test 1' });
      await db.put({ _id: 'doc2', name: 'Test 2' });

      // 执行同步
      await syncEngine.sync();

      // 验证文档已被同步到存储
      const storage = new StorageManager(fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
      });
      await storage.initialize();
      
      const storedDocs = await storage.readAllDocuments();
      expect(storedDocs.length).toBe(2);
      expect(storedDocs.find(d => d._id === 'doc1')).toBeDefined();
      expect(storedDocs.find(d => d._id === 'doc2')).toBeDefined();
    });

    it('should handle empty database', async () => {
      // 执行同步（空数据库）
      await syncEngine.sync();
      
      // 验证没有错误
      const storage = new StorageManager(fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
      });
      await storage.initialize();
      
      const storedDocs = await storage.readAllDocuments();
      expect(storedDocs.length).toBe(0);
    });

    it('should sync document updates', async () => {
      // 添加初始文档
      const doc = await db.put({ _id: 'doc1', name: 'Initial' });
      
      // 执行第一次同步
      await syncEngine.sync();
      
      // 更新文档
      await db.put({ _id: 'doc1', _rev: doc.rev, name: 'Updated' });
      
      // 执行第二次同步
      await syncEngine.sync();
      
      // 验证存储中的文档已更新
      const storage = new StorageManager(fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
      });
      await storage.initialize();
      
      const storedDocs = await storage.readAllDocuments();
      expect(storedDocs.length).toBe(1);
      expect(storedDocs[0].name).toBe('Updated');
    });

    it('should preserve _revisions when saving changed docs to storage', async () => {
      const created = await db.put({ _id: 'doc-with-revs', name: 'Initial' });
      const updated = await db.put({ _id: 'doc-with-revs', _rev: created.rev, name: 'Updated' });

      await syncEngine.sync();

      const storage = new StorageManager(fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
      });
      await storage.initialize();

      const storedDocs = await storage.readAllDocuments();
      const storedDoc = storedDocs.find(d => d._id === 'doc-with-revs') as any;
      expect(storedDoc).toBeDefined();
      expect(storedDoc._rev).toBe(updated.rev);
      expect(storedDoc._revisions).toBeDefined();
      expect(storedDoc._revisions.start).toBe(2);
      expect(storedDoc._revisions.ids).toHaveLength(2);
    });
  });

  describe('pull', () => {
    it('should pull documents from storage to PouchDB', async () => {
      // 先在存储中添加文档
      const storage = new StorageManager(fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
      });
      await storage.initialize();
      
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '1-abc', name: 'Test 1' },
        { _id: 'doc2', _rev: '1-def', name: 'Test 2' },
      ]);
      
      // 执行拉取
      await syncEngine.pull();
      
      // 验证文档已被拉取到数据库
      const docs = await db.allDocs({ include_docs: true });
      expect(docs.rows.length).toBe(2);
      expect(docs.rows.some((row: any) => row.id === 'doc1')).toBe(true);
      expect(docs.rows.some((row: any) => row.id === 'doc2')).toBe(true);
    });

    it('should handle empty storage', async () => {
      // 执行拉取（空存储）
      await syncEngine.pull();
      
      // 验证没有错误
      const docs = await db.allDocs();
      expect(docs.rows.length).toBe(0);
    });

    it('should pull document updates', async () => {
      // 先在存储中添加初始文档
      const storage = new StorageManager(fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
      });
      await storage.initialize();
      
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '1-abc', name: 'Initial' },
      ]);
      
      // 第一次拉取
      await syncEngine.pull();
      
      // 更新存储中的文档
      await storage.writeDocuments([
        { _id: 'doc1', _rev: '2-def', name: 'Updated' },
      ]);
      
      // 第二次拉取
      await syncEngine.pull();
      
      // 验证数据库中的文档已更新
      const doc: any = await db.get('doc1');
      expect(doc.name).toBe('Updated');
    });

    it('should call conflictResolver for same generation different hash conflicts', async () => {
      await db.put({ _id: 'doc-conflict', name: 'Local' });

      const storage = new StorageManager(fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
      });
      await storage.initialize();
      await storage.writeDocuments([
        { _id: 'doc-conflict', _rev: '1-remote', name: 'Remote' },
      ]);

      const conflictResolver = jest.fn((localDoc: any, remoteDoc: any, context: any) => ({ action: 'use-remote' as const }));
      const engine = new SyncEngine(db, fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
        autoMerge: false,
        conflictResolver,
      });
      await engine.initialize();
      await engine.pull();

      expect(conflictResolver).toHaveBeenCalledTimes(1);
      expect(conflictResolver.mock.calls[0][2]).toMatchObject({
        docId: 'doc-conflict',
        direction: 'pull',
        reason: 'conflict',
      });

      const doc: any = await db.get('doc-conflict');
      expect(doc.name).toBe('Remote');
    });

    it('should write merged resolver document to PouchDB', async () => {
      await db.put({ _id: 'doc-merge', name: 'Local', tags: ['local'] });

      const storage = new StorageManager(fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
      });
      await storage.initialize();
      await storage.writeDocuments([
        { _id: 'doc-merge', _rev: '1-remote', name: 'Remote', tags: ['remote'] },
      ]);

      const engine = new SyncEngine(db, fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
        autoMerge: false,
        conflictResolver: () => ({
          action: 'merge',
          doc: { _id: 'doc-merge', name: 'Merged', tags: ['local', 'remote'] },
        }),
      });
      await engine.initialize();
      await engine.pull();

      const doc: any = await db.get('doc-merge');
      expect(doc.name).toBe('Merged');
      expect(doc.tags).toEqual(['local', 'remote']);
    });

    it('should keep unresolved conflicts as _sync_conflict documents', async () => {
      await db.put({ _id: 'doc-keep-conflict', name: 'Local' });

      const storage = new StorageManager(fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
      });
      await storage.initialize();
      await storage.writeDocuments([
        { _id: 'doc-keep-conflict', _rev: '1-remote', name: 'Remote' },
      ]);

      await syncEngine.pull();

      const localDoc: any = await db.get('doc-keep-conflict');
      expect(localDoc.name).toBe('Local');

      const result: any = await db.allDocs({
        startkey: 'sync_conflict:',
        endkey: 'sync_conflict:\uffff',
        include_docs: true,
      });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].doc.docId).toBe('doc-keep-conflict');
      expect(result.rows[0].doc.remoteDoc.name).toBe('Remote');
    });
  });

  describe('performMerge', () => {
    it('should perform file merging', async () => {
      // 在数据库中添加多个小文档
      for (let i = 0; i < 5; i++) {
        await db.put({ _id: `doc${i}`, name: `Test ${i}` });
      }
      
      // 同步文档到存储
      await syncEngine.sync();
      
      // 执行合并
      await syncEngine.performMerge();
      
      // 验证合并操作成功完成
      const storage = new StorageManager(fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
      });
      await storage.initialize();
      
      const storedDocs = await storage.readAllDocuments();
      expect(storedDocs.length).toBe(5);
    });
  });

  describe('full sync', () => {
    it('should perform full sync cycle', async () => {
      // 在源数据库中添加文档
      await db.put({ _id: 'doc1', name: 'Test Document' });
      
      // 同步到存储
      await syncEngine.sync();
      
      // 创建新的数据库和同步引擎用于拉取
      let newDb;
      if (memoryAdapterLoaded) {
        console.log('Creating new database with memory adapter');
        newDb = new PouchDB('new-test-db', { adapter: 'memory' });
      } else {
        console.log('Creating new database with default adapter (memory adapter failed to load)');
        newDb = new PouchDB('new-test-db');
      }
      const newSyncEngine = new SyncEngine(newDb, fs, {
        basePath: '/test-sync',
        maxFileSize: 1024 * 100,
        mergeThreshold: 1024 * 10,
        autoMerge: false,
      });
      await newSyncEngine.initialize();
      
      // 从存储拉取到新数据库
      await newSyncEngine.pull();
      
      // 验证文档已同步到新数据库
      const newDocs: any = await newDb.allDocs({ include_docs: true });
      expect(newDocs.rows.length).toBe(1);
      expect(newDocs.rows[0].doc?.name).toBe('Test Document');
      
      // 清理
      await newDb.destroy();
    });
  });
});
