import { StorageManager } from '../src/core/storage-manager';
import { SyncEngine } from '../src/core/sync-engine';
import { MemoryFileSystem } from './memory-fs';
import { StoredDocument } from '../src/types';
import { parseTimestampFromFilename, uniqueSuffix, isDataFile } from '../src/utils/helpers';
import PouchDB from 'pouchdb-core';

let memoryAdapterLoaded = false;
import('pouchdb-adapter-memory').then((module) => {
  const PouchDBMemory = module.default || module;
  PouchDB.plugin(PouchDBMemory as any);
  memoryAdapterLoaded = true;
}).catch(() => {
  memoryAdapterLoaded = false;
});

function doc(id: string, rev: string, extra: Record<string, any> = {}): StoredDocument {
  return { _id: id, _rev: rev, ...extra } as StoredDocument;
}

async function waitForMemoryAdapter(): Promise<void> {
  let waited = 0;
  while (!memoryAdapterLoaded && waited < 3000) {
    await new Promise(resolve => setTimeout(resolve, 100));
    waited += 100;
  }
}

describe('写入路径唯一性（无锁方案的前提）', () => {
  let fs: MemoryFileSystem;
  let storage: StorageManager;
  const fixedNow = 1700000000000;

  beforeEach(async () => {
    fs = new MemoryFileSystem();
    storage = new StorageManager(fs, { basePath: '/unique-test', maxFileSize: 1024 * 100 });
    await storage.initialize();
  });

  afterEach(() => {
    fs.clear();
  });

  it('同一毫秒的两次写入产生不同文件名，且两份内容都在', async () => {
    const realNow = Date.now;
    Date.now = () => fixedNow;
    try {
      await storage.writeDocuments([doc('a', '1-aaa', { name: 'A' })]);
      await storage.writeDocuments([doc('b', '1-bbb', { name: 'B' })]);
    } finally {
      Date.now = realNow;
    }

    const dataFiles = fs.getAllFiles().filter(f => f.includes('/data/'));
    expect(dataFiles.length).toBe(2);
    expect(dataFiles[0]).not.toBe(dataFiles[1]);
    for (const f of dataFiles) {
      expect(f).toMatch(/\/data\/\d{4}\/\d{2}\/\d{2}\/data-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{8}\.json$/);
    }

    // 两份文档都还在（不会互相覆盖）
    const all = await storage.readAllDocuments();
    expect(all.map(d => d._id).sort()).toEqual(['a', 'b']);
  });

  it('uniqueSuffix 是 8 位 base36', () => {
    for (let i = 0; i < 50; i++) {
      expect(uniqueSuffix()).toMatch(/^[a-z0-9]{8}$/);
    }
  });

  it('parseTimestampFromFilename 兼容带后缀与旧版无后缀', () => {
    const expected = Date.parse('2026-08-14T10:00:00.000Z');
    expect(parseTimestampFromFilename('data-2026-08-14T10-00-00-000Z.json')).toBe(expected);
    expect(parseTimestampFromFilename('data-2026-08-14T10-00-00-000Z-a1b2c3d4.json')).toBe(expected);
    expect(parseTimestampFromFilename('merged-2026-08-14T10-00-00-000Z-a1b2c3d4.json')).toBe(expected);
  });

  it('原子写的临时文件不会被当成数据文件', () => {
    expect(isDataFile('data-2026-11-21T10-00-00-000Z-abcd1234.json.efgh5678.tmp')).toBe(false);
    expect(isDataFile('data-2026-11-21T10-00-00-000Z-abcd1234.json')).toBe(true);
  });
});

describe('SyncEngine 不再使用跨进程锁', () => {
  let fs: MemoryFileSystem;
  let db: PouchDB.Database;
  let engine: SyncEngine;

  beforeEach(async () => {
    fs = new MemoryFileSystem();
    await waitForMemoryAdapter();
    db = memoryAdapterLoaded
      ? new PouchDB('test-nolock-db', { adapter: 'memory' })
      : new PouchDB('test-nolock-db');
    engine = new SyncEngine(db, fs, {
      basePath: '/nolock-test',
      maxFileSize: 1024 * 100,
      autoMerge: false,
    });
    await engine.initialize();
  });

  afterEach(async () => {
    await db.destroy();
    fs.clear();
  });

  it('sync() 不产生 .sync.lock / .merge.lock', async () => {
    await db.put({ _id: 'doc1', name: 'Test 1' });
    await engine.sync();

    const lockFiles = fs.getAllFiles().filter(f => f.endsWith('.lock'));
    expect(lockFiles).toEqual([]);
    expect(fs.getAllFiles().filter(f => f.includes('/data/')).length).toBe(1);
  });

  it('performMerge() 不产生锁文件，且并发调用不会重复合并', async () => {
    await db.put({ _id: 'doc1', name: 'Test 1' });
    await engine.sync();

    await Promise.all([engine.performMerge(true), engine.performMerge(true)]);

    const mergedFiles = fs.getAllFiles().filter(f => f.includes('/merged/') && f.endsWith('.json'));
    expect(mergedFiles.length).toBe(1);
    expect(fs.getAllFiles().filter(f => f.endsWith('.lock'))).toEqual([]);
  });
});
