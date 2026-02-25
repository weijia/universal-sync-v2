import { SyncEngine } from '../src/core/sync-engine';
import { StorageManager } from '../src/core/storage-manager';
import { MemoryFileSystem } from './memory-fs';
import PouchDB from 'pouchdb-core';

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