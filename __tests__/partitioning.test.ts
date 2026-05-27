import { StorageManager } from '../src/core/storage-manager';
import { MemoryFileSystem } from './memory-fs';
import { StoredDocument } from '../src/types';

describe('Partitioned storage', () => {
  let fs: MemoryFileSystem;
  let storage: StorageManager;

  beforeEach(async () => {
    fs = new MemoryFileSystem();
    storage = new StorageManager(fs, {
      basePath: '/test-storage',
      maxFileSize: 1024 * 100,
      mergeThreshold: 1024 * 10,
    });
    await storage.initialize();
  });

  afterEach(() => {
    fs.clear();
  });

  it('writes data files into root directory (simplified strategy)', async () => {
    const docs: StoredDocument[] = [
      { _id: 'p1', _rev: '1-a', data: 'x' },
    ];

    await storage.writeDocuments(docs);

    const files = fs.getAllFiles();
    // 简化策略：新文件直接写入根目录
    const rootPath = `/test-storage/data/`;
    const dataFiles = files.filter(f => f.startsWith(rootPath) && f.endsWith('.json'));
    expect(dataFiles.length).toBeGreaterThan(0);
    // 文件应该在根目录，而不是分区目录
    expect(dataFiles.some(f => !f.includes('/20'))).toBe(true);
  });

  it('reorganize moves files to year/month partition', async () => {
    // 使用低阈值以便测试重排
    const lowThresholdStorage = new StorageManager(fs, {
      basePath: '/test-storage',
      maxFileSize: 1024 * 100,
      mergeThreshold: 1024 * 10,
      reorgThreshold: 0, // 低阈值，任何文件都会触发重排
      reorgBatchSize: 10,
    });
    await lowThresholdStorage.initialize();

    const docs: StoredDocument[] = [
      { _id: 'p1', _rev: '1-a', data: 'x' },
    ];

    await lowThresholdStorage.writeDocuments(docs);

    // 先写入根目录
    let files = fs.getAllFiles();
    const rootDataFiles = files.filter(f => f.startsWith('/test-storage/data/') && f.endsWith('.json') && !f.includes('/20'));
    expect(rootDataFiles.length).toBeGreaterThan(0);

    // 执行重排
    const result = await lowThresholdStorage.reorganize();
    expect(result.movedFiles).toBeGreaterThan(0);

    // 重排后文件应该在分区目录
    files = fs.getAllFiles();
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const partitionPath = `/test-storage/data/${year}/${month}/`;
    expect(files.some(f => f.startsWith(partitionPath))).toBe(true);
  });

  it('readAllDocuments returns latest version across locations', async () => {
    // write initial version
    await storage.writeDocuments([
      { _id: 'shared', _rev: '1-aaa', value: 1 },
    ]);

    // write updated version
    await storage.writeDocuments([
      { _id: 'shared', _rev: '2-bbb', value: 2 },
    ]);

    const docs = await storage.readAllDocuments();
    const d = docs.find(x => x._id === 'shared');
    expect(d).toBeDefined();
    expect(d && d.value).toBe(2);
  });

  it('reorganize dryRun does not move files', async () => {
    // 使用低阈值以便测试重排
    const lowThresholdStorage = new StorageManager(fs, {
      basePath: '/test-storage',
      maxFileSize: 1024 * 100,
      mergeThreshold: 1024 * 10,
      reorgThreshold: 0, // 低阈值，任何文件都会触发重排
      reorgBatchSize: 10,
    });
    await lowThresholdStorage.initialize();

    const docs: StoredDocument[] = [
      { _id: 'p1', _rev: '1-a', data: 'x' },
    ];

    await lowThresholdStorage.writeDocuments(docs);

    // 记录重排前的文件列表
    const filesBefore = fs.getAllFiles().filter(f => f.endsWith('.json'));

    // 执行 dry-run 重排
    const result = await lowThresholdStorage.reorganize({ dryRun: true });
    expect(result.movedFiles).toBeGreaterThan(0); // dry-run 也会报告会移动的文件数

    // 文件位置应该没有变化
    const filesAfter = fs.getAllFiles().filter(f => f.endsWith('.json'));
    expect(filesAfter.sort()).toEqual(filesBefore.sort());
  });
});
