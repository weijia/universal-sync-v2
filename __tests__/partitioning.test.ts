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

  it('writes data files into year/month partition', async () => {
    const docs: StoredDocument[] = [
      { _id: 'p1', _rev: '1-a', data: 'x' },
    ];

    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');

    await storage.writeDocuments(docs);

    const files = fs.getAllFiles();
    const partitionPath = `/test-storage/data/${year}/${month}/`;
    expect(files.some(f => f.startsWith(partitionPath))).toBe(true);
  });

  it('creates manifest-index.json with partition entry', async () => {
    await storage.writeDocuments([
      { _id: 'p2', _rev: '1-b', data: 'y' },
    ]);

    const indexPath = '/test-storage/manifest-index.json';
    const content = await fs.readFile(indexPath, 'utf8');
    const idx = JSON.parse(content);

    expect(idx).toBeDefined();
    expect(typeof idx.partitions).toBe('object');
    const parts = Object.keys(idx.partitions || {});
    expect(parts.length).toBeGreaterThan(0);
  });

  it('readAllDocuments returns latest version across partitions', async () => {
    // write initial version
    await storage.writeDocuments([
      { _id: 'shared', _rev: '1-aaa', value: 1 },
    ]);

    // write updated version (will create another partition file with later seq)
    await storage.writeDocuments([
      { _id: 'shared', _rev: '2-bbb', value: 2 },
    ]);

    const docs = await storage.readAllDocuments();
    const d = docs.find(x => x._id === 'shared');
    expect(d).toBeDefined();
    expect(d && d.value).toBe(2);
  });
});
