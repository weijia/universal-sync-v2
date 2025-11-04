import PouchDB from 'pouchdb-core';
import { IFileSystem, StoredDocument, SyncOptions } from '../types.js';
import { StorageManager } from './storage-manager.js';
import { LockManager } from './lock-manager.js';

/**
 * PouchDB 同步引擎
 * 负责 PouchDB 与文件存储之间的双向同步
 */
export class SyncEngine {
  private storageManager: StorageManager;
  private lockManager: LockManager;
  private syncInProgress = false;
  private mergeInProgress = false;
  private mergeTimer?: ReturnType<typeof setInterval>;

  constructor(
    private db: PouchDB.Database,
    private fs: IFileSystem,
    private options: SyncOptions
  ) {
    this.storageManager = new StorageManager(fs, options);
    this.lockManager = new LockManager(fs, options.basePath);
  }

  /**
   * 初始化同步
   */
  async initialize(): Promise<void> {
    await this.storageManager.initialize();
  }

  /**
   * 仅从文件加载到 PouchDB（pull-only 同步）
   */
  async pull(): Promise<void> {
    if (this.syncInProgress) {
      console.log('Sync already in progress, skipping pull...');
      return;
    }

    this.syncInProgress = true;
    try {
      await this.lockManager.withLock('sync', 'pull-sync', async () => {
        await this.loadFromFiles();
      });
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * 执行完整同步
   */
  async sync(): Promise<void> {
    if (this.syncInProgress) {
      console.log('Sync already in progress, skipping...');
      return;
    }

    this.syncInProgress = true;

    try {
      // 使用锁确保只有一个进程在同步
      await this.lockManager.withLock('sync', 'full-sync', async () => {
        // 1. 从文件加载到 PouchDB
        await this.loadFromFiles();

        // 2. 从 PouchDB 保存到文件
        await this.saveToFiles();
      });

      // 3. 启动自动合并（如果启用）
      if (this.options.autoMerge) {
        this.startAutoMerge();
      }
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * 从文件加载到 PouchDB（从最新开始）
   */
  private async loadFromFiles(): Promise<void> {
    // 获取 PouchDB 当前的更新序列号
    const info = await this.db.info();
    const localSeq = info.update_seq as number || 0;

    // 读取增量文档（如果是首次同步，读取所有文档）
    // 如果本地 PouchDB 的更新序列号大于清单记录的最后序列号，说明本地 DB 比远端更新（或清单不完整），
    // 在这种情况下我们选择拉取所有数据文件以确保不丢失任何远端内容（并记录警告）。
    const remoteLastSeq = await this.storageManager.getLastSequence();
    let documents: StoredDocument[] = [];

    if (localSeq === 0) {
      documents = await this.storageManager.readAllDocuments();
    } else if (localSeq > remoteLastSeq) {
      console.warn(`Local DB seq (${localSeq}) > remote manifest lastSeq (${remoteLastSeq}). Performing full pull.`);
      documents = await this.storageManager.readAllDocuments();
    } else {
      documents = await this.storageManager.readIncrementalDocuments(localSeq);
    }

    if (documents.length === 0) {
      return;
    }

    // 批量更新到 PouchDB
    const docsToUpdate: any[] = [];

    for (const doc of documents) {
      try {
        // 检查文档是否存在
        const existingDoc = await this.db.get(doc._id).catch(() => null);

        if (existingDoc) {
          // 比较版本，只更新更新的版本
          if (this.isNewerVersion(doc._rev, existingDoc._rev)) {
            docsToUpdate.push({ ...doc, _rev: existingDoc._rev });
          }
        } else {
          // 新文档
          const { _rev, ...docWithoutRev } = doc;
          docsToUpdate.push(docWithoutRev);
        }
      } catch (error) {
        console.error(`Error processing document ${doc._id}:`, error);
      }
    }

    if (docsToUpdate.length > 0) {
      await this.db.bulkDocs(docsToUpdate);
    }
  }

  /**
   * 从 PouchDB 保存到文件
   */
  private async saveToFiles(): Promise<void> {
    // 获取 PouchDB 中的所有文档
    const result = await this.db.allDocs({
      include_docs: true,
    });

    const documents: StoredDocument[] = result.rows
      .filter((row: any) => row.doc && !row.id.startsWith('_design/'))
      .map((row: any) => row.doc as StoredDocument);

    if (documents.length === 0) {
      return;
    }

    // 写入文件
    await this.storageManager.writeDocuments(documents);
  }

  /**
   * 启动自动合并
   */
  private startAutoMerge(): void {
    if (this.mergeTimer) {
      return;
    }

    const interval = this.options.mergeInterval || 60000;

    this.mergeTimer = setInterval(() => {
      this.performMerge().catch(error => {
        console.error('Auto merge failed:', error);
      });
    }, interval);
  }

  /**
   * 停止自动合并
   */
  stopAutoMerge(): void {
    if (this.mergeTimer) {
      clearInterval(this.mergeTimer);
      this.mergeTimer = undefined;
    }
  }

  /**
   * 执行文件合并
   */
  async performMerge(): Promise<void> {
    if (this.mergeInProgress) {
      console.log('Merge already in progress, skipping...');
      return;
    }

    this.mergeInProgress = true;

    try {
      // 使用锁确保只有一个进程在合并
      await this.lockManager.withLock('merge', 'file-merge', async () => {
        const candidates = await this.storageManager.getMergeCandidates();

        for (const group of candidates) {
          try {
            await this.storageManager.mergeFiles(group);
            console.log(`Merged ${group.length} files`);
          } catch (error) {
            console.error('Failed to merge files:', error);
          }
        }
      });
    } finally {
      this.mergeInProgress = false;
    }
  }

  /**
   * 比较版本号
   */
  private isNewerVersion(rev1: string, rev2: string): boolean {
    const seq1 = parseInt(rev1.split('-')[0], 10);
    const seq2 = parseInt(rev2.split('-')[0], 10);
    return seq1 > seq2;
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    this.stopAutoMerge();
  }
}
