import PouchDB from 'pouchdb-core';
import { IFileSystem, StoredDocument, SyncOptions } from '../types.js';
import { StorageManager } from './storage-manager.js';
import { LockManager } from './lock-manager.js';

// 调试开关 - 可以通过环境变量控制
const DEBUG = typeof process !== 'undefined' ? process.env.DEBUG === 'true' : true;
const PREFIX = '[SyncEngine]';

function debug(...args: any[]) {
  if (DEBUG) {
    console.log(PREFIX, ...args);
  }
}

function debugError(...args: any[]) {
  console.error(PREFIX, ...args);
}

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
  private localSeqDocId: string; // _local 文档 ID，用于存储每个数据源的推送序列号

  constructor(
    private db: PouchDB.Database,
    private fs: IFileSystem,
    private options: SyncOptions
  ) {
    debug('构造函数初始化, basePath:', options.basePath);
    this.storageManager = new StorageManager(fs, options);
    this.lockManager = new LockManager(fs, options.basePath);
    // 用 basePath 生成唯一的本地文档 ID，确保多个数据源互不干扰
    const safeBasePath = (options.basePath || '/').replace(/[^a-zA-Z0-9]/g, '_');
    this.localSeqDocId = `_local/sync-seq:${safeBasePath}`;
  }

  /**
   * 初始化同步
   */
  async initialize(): Promise<void> {
    debug('开始初始化...');
    await this.storageManager.initialize();
    debug('初始化完成');
  }

  /**
   * 获取远程最后序列号
   */
  async getLastSequence(): Promise<number> {
    return await this.storageManager.getLastSequence();
  }

  /**
   * 仅从文件加载到 PouchDB（pull-only 同步）
   */
  async pull(): Promise<void> {
    debug('--- pull() 开始 ---');
    
    if (this.syncInProgress) {
      debug('同步已在进行中，跳过 pull');
      return;
    }

    this.syncInProgress = true;
    try {
      await this.lockManager.withLock('sync', 'pull-sync', async () => {
        await this.loadFromFiles();
      });
    } finally {
      this.syncInProgress = false;
      debug('--- pull() 结束 ---');
    }
  }

  /**
   * 执行完整同步
   */
  async sync(): Promise<void> {
    debug('--- sync() 开始 ---');
    
    if (this.syncInProgress) {
      debug('同步已在进行中，跳过');
      return;
    }

    this.syncInProgress = true;

    try {
      await this.lockManager.withLock('sync', 'full-sync', async () => {
        await this.loadFromFiles();
        await this.saveToFiles();
      });

      if (this.options.autoMerge) {
        this.startAutoMerge();
      }

      if (this.options.autoReorganize) {
        await this.performReorganization();
      }
    } finally {
      this.syncInProgress = false;
      debug('--- sync() 结束 ---');
    }
  }

  /**
   * 从文件加载到 PouchDB（从最新开始）
   */
  private async loadFromFiles(): Promise<void> {
    debug('loadFromFiles() 开始');
    
    // 获取 PouchDB 当前的更新序列号
    const info = await this.db.info();
    const localSeq = info.update_seq as number || 0;
    debug('PouchDB 当前状态:', { doc_count: info.doc_count, update_seq: localSeq });

    // 读取增量文档
    const remoteLastSeq = await this.storageManager.getLastSequence();
    debug('远程 manifest lastSequence:', remoteLastSeq);
    
    let documents: StoredDocument[] = [];

    if (localSeq === 0) {
      debug('首次同步，读取所有文档');
      documents = await this.storageManager.readAllDocuments();
    } else if (localSeq > remoteLastSeq) {
      debug(`本地 seq (${localSeq}) > 远程 manifest lastSeq (${remoteLastSeq})，执行完整拉取`);
      documents = await this.storageManager.readAllDocuments();
    } else {
      debug(`增量同步，从 seq ${localSeq} 开始`);
      documents = await this.storageManager.readIncrementalDocuments(localSeq);
    }

    debug('从文件读取到的文档数量:', documents.length);
    
    if (documents.length === 0) {
      debug('没有文档需要加载，退出');
      return;
    }

    // 显示前几个文档的 ID
    debug('文档 ID 示例:', documents.slice(0, 3).map(d => d._id));

    // 批量更新到 PouchDB
    const docsToUpdate: any[] = [];

    for (const doc of documents) {
      try {
        // 检查文档是否存在
        const existingDoc = await this.db.get(doc._id).catch(() => null);

        if (existingDoc) {
          debug(`文档 ${doc._id} 已存在，远程 rev: ${doc._rev}, 本地 rev: ${existingDoc._rev}`);
          // 比较版本，只更新更新的版本
          if (this.isNewerVersion(doc._rev, existingDoc._rev)) {
            debug(`  -> 远程版本更新，更新文档`);
            docsToUpdate.push({ ...doc, _rev: existingDoc._rev });
          } else {
            debug(`  -> 本地版本更新或相同，跳过`);
          }
        } else {
          // 新文档
          debug(`文档 ${doc._id} 是新文档，将添加`);
          const { _rev, ...docWithoutRev } = doc;
          docsToUpdate.push(docWithoutRev);
        }
      } catch (error) {
        debugError(`处理文档 ${doc._id} 时出错:`, error);
      }
    }

    debug('实际需要更新的文档数量:', docsToUpdate.length);
    
    if (docsToUpdate.length > 0) {
      debug('开始 bulkDocs...');
      const result = await this.db.bulkDocs(docsToUpdate);
      
      // 统计结果
      let ok = 0, error = 0;
      for (const r of result) {
        if ((r as any).ok) ok++;
        else error++;
      }
      debug(`bulkDocs 完成: ${ok} 成功, ${error} 失败`);
      
      // 显示错误
      for (const r of result) {
        if (!(r as any).ok) {
          debugError(`写入失败:`, r);
        }
      }
    } else {
      debug('没有文档需要更新');
    }
    
    debug('loadFromFiles() 结束');
  }

  /**
   * 从 PouchDB 保存到文件（增量写入）
   * 只写入自上次同步以来有变更的文档
   * 序列号存储在 PouchDB _local 文档中，按数据源隔离，不影响其他同步源
   */
  private async saveToFiles(): Promise<void> {
    debug('saveToFiles() 开始');

    // 从 _local 文档读取上次推送的序列号（按数据源隔离）
    let lastPushedSeq = 0;
    try {
      const localDoc = await this.db.get(this.localSeqDocId) as any;
      lastPushedSeq = localDoc?.lastPushedSeq || 0;
    } catch {
      // 文档不存在，首次推送
    }
    debug('上次推送的序列号:', lastPushedSeq, '(doc:', this.localSeqDocId, ')');

    // 获取 PouchDB 当前状态
    const info = await this.db.info();
    const currentSeq = info.update_seq as number || 0;
    debug('PouchDB 当前序列号:', currentSeq);

    if (currentSeq <= lastPushedSeq) {
      debug('没有新的变更需要推送，跳过 saveToFiles');
      return;
    }

    // 使用 PouchDB changes API 获取增量变更
    const changes = await this.db.changes({
      since: lastPushedSeq,
      include_docs: true,
    });

    const changedDocs = changes.results
      .filter((row: any) => row.doc && !row.id.startsWith('_design/'))
      .map((row: any) => row.doc as StoredDocument);

    debug('增量变更文档数量:', changedDocs.length);

    if (changedDocs.length === 0) {
      debug('没有变更文档需要保存');
      // 即使没有文档变更，也更新序列号
      try {
        await this.db.put({
          _id: this.localSeqDocId,
          lastPushedSeq: currentSeq,
        });
      } catch {
        try {
          const existing = await this.db.get(this.localSeqDocId) as any;
          await this.db.put({
            ...existing,
            lastPushedSeq: currentSeq,
          });
        } catch {
          // ignore
        }
      }
      return;
    }

    await this.storageManager.writeDocuments(changedDocs);

    // 更新已推送的序列号到 _local 文档
    try {
      await this.db.put({
        _id: this.localSeqDocId,
        lastPushedSeq: currentSeq,
      });
    } catch {
      try {
        const existing = await this.db.get(this.localSeqDocId) as any;
        await this.db.put({
          ...existing,
          lastPushedSeq: currentSeq,
        });
      } catch {
        // ignore
      }
    }

    debug('增量文档已写入文件，序列号更新为:', currentSeq);
    debug('saveToFiles() 结束');
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
        debugError('自动合并失败:', error);
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
      debug('合并已在进行中，跳过');
      return;
    }

    this.mergeInProgress = true;

    try {
      await this.lockManager.withLock('merge', 'file-merge', async () => {
        const candidates = await this.storageManager.getMergeCandidates();

        for (const group of candidates) {
          try {
            await this.storageManager.mergeFiles(group);
            debug(`合并了 ${group.length} 个文件`);
          } catch (error) {
            debugError('合并文件失败:', error);
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
   * 执行目录重排
   */
  async performReorganization(): Promise<void> {
    try {
      const shouldReorg = await this.storageManager.shouldReorganize();
      if (!shouldReorg) {
        return;
      }

      debug('开始目录重组...');

      await this.lockManager.withLock('reorg', 'directory-reorganization', async () => {
        const result = await this.storageManager.reorganize();
        
        if (result.movedFiles > 0) {
          debug(`重组完成: 移动了 ${result.movedFiles} 个文件`);
        }
        
        if (result.failedFiles > 0) {
          debugError(`重组: ${result.failedFiles} 个文件失败`);
        }
      });
    } catch (error) {
      debugError('目录重组失败:', error);
    }
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    this.stopAutoMerge();
  }
}
