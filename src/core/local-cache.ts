import PouchDB from 'pouchdb-core';
import {
  RemoteRevCache,
  ProcessedFilesCache,
  SyncSeqCache,
} from '../types.js';

/**
 * 本地缓存管理器
 *
 * rev2 设计用 PouchDB 的 _local 文档存放三份缓存，避免污染目标文件系统、
 * 不参与 replication、且在 Node / 浏览器环境下均可工作。
 *
 * - remote-rev-cache：记录目标文件系统每个文档当前的 _rev，用于 push 差异筛选
 * - processed-files：记录已写入文件的内容哈希，用于 pull 时跳过未变文件
 * - sync-seq：上次 push 的 update_seq，用于轻量跳过
 */
export class LocalCache {
  constructor(
    private db: PouchDB.Database,
    private basePath: string
  ) {}

  private remoteRevDocId(): string {
    return `_local/sync-remote-rev:${this.basePath}`;
  }

  private processedFilesDocId(): string {
    return `_local/sync-processed-files:${this.basePath}`;
  }

  private syncSeqDocId(): string {
    return `_local/sync-seq:${this.basePath}`;
  }

  // ---------- remote-rev-cache ----------

  async getRemoteRevCache(): Promise<RemoteRevCache> {
    const doc = await this.readLocal<RemoteRevCache>(this.remoteRevDocId());
    return doc ?? { basePath: this.basePath, revs: {} };
  }

  async setRemoteRevCache(cache: RemoteRevCache): Promise<void> {
    await this.writeLocal(this.remoteRevDocId(), cache);
  }

  // ---------- processed-files ----------

  async getProcessedFiles(): Promise<ProcessedFilesCache> {
    const doc = await this.readLocal<ProcessedFilesCache>(this.processedFilesDocId());
    return doc ?? { basePath: this.basePath, hashes: {} };
  }

  async setProcessedFiles(cache: ProcessedFilesCache): Promise<void> {
    await this.writeLocal(this.processedFilesDocId(), cache);
  }

  // ---------- sync-seq ----------

  async getSyncSeq(): Promise<SyncSeqCache> {
    const doc = await this.readLocal<SyncSeqCache>(this.syncSeqDocId());
    return doc ?? { basePath: this.basePath, lastPushedSeq: null };
  }

  async setSyncSeq(cache: SyncSeqCache): Promise<void> {
    await this.writeLocal(this.syncSeqDocId(), cache);
  }

  // ---------- 底层读写 ----------

  private async readLocal<T extends { basePath: string }>(docId: string): Promise<T | null> {
    try {
      return (await this.db.get<T & PouchDB.Core.IdMeta>(docId)) as T;
    } catch (err: any) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  private async writeLocal<T extends { basePath: string }>(docId: string, doc: T): Promise<void> {
    let existing: (T & PouchDB.Core.IdMeta & PouchDB.Core.RevisionIdMeta) | null = null;
    try {
      existing = await this.db.get<T & PouchDB.Core.IdMeta & PouchDB.Core.RevisionIdMeta>(docId);
    } catch {
      existing = null;
    }

    if (existing) {
      await this.db.put({ ...doc, _id: docId, _rev: existing._rev });
    } else {
      await this.db.put({ ...doc, _id: docId });
    }
  }
}
