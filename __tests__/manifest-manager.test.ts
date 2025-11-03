import { ManifestManager } from '../src/core/manifest-manager';
import { MemoryFileSystem } from './memory-fs';
import { DataFileMetadata } from '../src/types';

describe('ManifestManager', () => {
  let fs: MemoryFileSystem;
  let manifest: ManifestManager;

  beforeEach(async () => {
    fs = new MemoryFileSystem();
    await fs.mkdir('/test-storage', { recursive: true });
    manifest = new ManifestManager(fs, '/test-storage');
  });

  afterEach(() => {
    fs.clear();
  });

  describe('readManifest', () => {
    it('should create empty manifest if not exists', async () => {
      const content = await manifest.readManifest();
      
      expect(content.version).toBeDefined();
      expect(content.lastSequence).toBe(0);
      expect(content.files).toEqual([]);
    });

    it('should read existing manifest', async () => {
      const testManifest = {
        version: '2.0.0',
        lastSequence: 5,
        lastTimestamp: Date.now(),
        files: [],
      };

      await fs.writeFile(
        '/test-storage/manifest.json',
        JSON.stringify(testManifest)
      );

      const content = await manifest.readManifest();
      expect(content.lastSequence).toBe(5);
    });
  });

  describe('addFile', () => {
    it('should add file metadata to manifest', async () => {
      const metadata: DataFileMetadata = {
        filename: 'data-1-2024-01-01.json',
        startSeq: 1,
        endSeq: 1,
        timestamp: Date.now(),
        documentCount: 10,
      };

      await manifest.addFile(metadata);

      const content = await manifest.readManifest();
      expect(content.files.length).toBe(1);
      expect(content.files[0].filename).toBe(metadata.filename);
      expect(content.lastSequence).toBe(1);
    });

    it('should update lastSequence when adding newer file', async () => {
      await manifest.addFile({
        filename: 'data-1.json',
        startSeq: 1,
        endSeq: 1,
        timestamp: Date.now(),
        documentCount: 5,
      });

      await manifest.addFile({
        filename: 'data-2.json',
        startSeq: 2,
        endSeq: 5,
        timestamp: Date.now(),
        documentCount: 10,
      });

      const content = await manifest.readManifest();
      expect(content.lastSequence).toBe(5);
      expect(content.files.length).toBe(2);
    });

    it('should keep files sorted by sequence', async () => {
      await manifest.addFile({
        filename: 'data-3.json',
        startSeq: 3,
        endSeq: 3,
        timestamp: Date.now(),
        documentCount: 5,
      });

      await manifest.addFile({
        filename: 'data-1.json',
        startSeq: 1,
        endSeq: 1,
        timestamp: Date.now(),
        documentCount: 5,
      });

      await manifest.addFile({
        filename: 'data-2.json',
        startSeq: 2,
        endSeq: 2,
        timestamp: Date.now(),
        documentCount: 5,
      });

      const content = await manifest.readManifest();
      expect(content.files[0].startSeq).toBe(1);
      expect(content.files[1].startSeq).toBe(2);
      expect(content.files[2].startSeq).toBe(3);
    });
  });

  describe('getFiles', () => {
    it('should return all files in order', async () => {
      await manifest.addFile({
        filename: 'data-2.json',
        startSeq: 2,
        endSeq: 2,
        timestamp: Date.now(),
        documentCount: 5,
      });

      await manifest.addFile({
        filename: 'data-1.json',
        startSeq: 1,
        endSeq: 1,
        timestamp: Date.now(),
        documentCount: 5,
      });

      const files = await manifest.getFiles();
      expect(files.length).toBe(2);
      expect(files[0].startSeq).toBe(1);
      expect(files[1].startSeq).toBe(2);
    });
  });

  describe('getLastSequence', () => {
    it('should return 0 for empty manifest', async () => {
      const seq = await manifest.getLastSequence();
      expect(seq).toBe(0);
    });

    it('should return last sequence number', async () => {
      await manifest.addFile({
        filename: 'data-1.json',
        startSeq: 1,
        endSeq: 3,
        timestamp: Date.now(),
        documentCount: 5,
      });

      const seq = await manifest.getLastSequence();
      expect(seq).toBe(3);
    });
  });

  describe('getMergeCandidates', () => {
    it('should identify mergeable files', async () => {
      // 添加多个小文件
      for (let i = 1; i <= 5; i++) {
        await manifest.addFile({
          filename: `data-${i}.json`,
          startSeq: i,
          endSeq: i,
          timestamp: Date.now(),
          documentCount: 2, // 估算为小文件
        });
      }

      const candidates = await manifest.getMergeCandidates(5000);
      expect(Array.isArray(candidates)).toBe(true);
    });

    it('should not include already merged files', async () => {
      await manifest.addFile({
        filename: 'data-1.json',
        startSeq: 1,
        endSeq: 1,
        timestamp: Date.now(),
        documentCount: 2,
      });

      await manifest.addFile({
        filename: 'merged-1-2.json',
        startSeq: 1,
        endSeq: 2,
        timestamp: Date.now(),
        documentCount: 4,
        mergedFrom: ['data-1.json', 'data-2.json'],
      });

      const candidates = await manifest.getMergeCandidates(5000);
      
      for (const group of candidates) {
        for (const file of group) {
          expect(file.mergedFrom).toBeUndefined();
        }
      }
    });
  });

  describe('updateFile', () => {
    it('should update existing file metadata', async () => {
      await manifest.addFile({
        filename: 'data-1.json',
        startSeq: 1,
        endSeq: 1,
        timestamp: Date.now(),
        documentCount: 5,
      });

      await manifest.updateFile('data-1.json', {
        mergedFrom: ['archived'],
      });

      const files = await manifest.getFiles();
      expect(files[0].mergedFrom).toEqual(['archived']);
    });

    it('should do nothing if file not found', async () => {
      await manifest.updateFile('non-existent.json', {
        documentCount: 100,
      });

      const files = await manifest.getFiles();
      expect(files.length).toBe(0);
    });
  });
});
