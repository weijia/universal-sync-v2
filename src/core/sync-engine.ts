import PouchDB from 'pouchdb-core';
import {
  IFileSystem,
  StoredDocument,
  SyncConflictDecision,
  SyncConflictReason,
  SyncOptions,
} from '../types.js';
import { StorageManager } from './storage-manager.js';
import { LockManager } from './lock-manager.js';
import { LocalCache } from './local-cache.js';
import { logSyncEngine } from '../utils/logger.js';

const PREFIX = '[SyncEngine]';
const debug = (...args: unknown[]): void => logSyncEngine.log(PREFIX, ...args);
const debugError = (...args: unknown[]): void => logSyncEngine.error(PREFIX, ...args);

/**
 * PouchDB 同步引擎（rev2：基于 _rev 差异，去 manifest / 全局 sequence / 目录重排）
 *
 * - push：轻量跳过 -> 初始化 remote-rev-cache（空则扫文件系统重建）-> 按 _rev generation 筛选差异 -> 二次 compareDocumentRevisions 兜底 -> 写入文件 -> 回写缓存
 * - pull：listAllDataFiles -> processed-files 过滤未变文件 -> compareDocumentRevisions -> bulkDocs -> 回写 remote-rev-cache
 * - 删除靠 tombstone（_deleted:true，_rev 变新自然被推送），无特殊分支
 */
export class SyncEngine {
  private storageManager: StorageManager;
  private lockManager: LockManager;
  private localCache: LocalCache;
  private syncInProgress = false;
  private mergeInProgress = false;
  private mergeTimer?: ReturnType<typeof setInterval>;

  constructor(
    private db: PouchDB.Database,
    private fs: IFileSystem,
    private options: SyncOptions
  ) {
    debug('构造函数初始化, basePath:', options.basePath);
    this.storageManager = new StorageManager(fs, options);
    this.lockManager = new LockManager(fs, options.basePath);
    this.localCache = new LocalCache(db, options.basePath);
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
        await this.pullFromFiles();
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
        await this.pullFromFiles();
        await this.pushToFiles();
      });

      if (this.options.autoMerge) {
        this.startAutoMerge();
      }
    } finally {
      this.syncInProgress = false;
      debug('--- sync() 结束 ---');
    }
  }

  // ============ PULL ============

  /**
   * 从目标文件系统拉取到 PouchDB
   */
  private async pullFromFiles(): Promise<void> {
    debug('pullFromFiles() 开始');

    const files = await this.storageManager.listAllDataFiles();
    debug('发现数据文件数量:', files.length);

    const processed = await this.localCache.getProcessedFiles();
    const { docs, fileHashes } = await this.readChangedDocs(files, processed.hashes);
    debug('需处理的文档数量:', docs.length);

    const toUpdate: any[] = [];
    for (const doc of docs) {
      const action = await this.resolvePullDocument(doc);
      if (action) toUpdate.push(action);
    }

    await this.applyBulkUpdates(toUpdate);
    await this.saveProcessedHashes(fileHashes, processed);
    await this.updateRemoteRevCacheFromDocs(docs);

    debug('pullFromFiles() 结束');
  }

  /**
   * 读取文件内容，按内容哈希过滤未变文件，返回文档与文件哈希映射
   */
  private async readChangedDocs(
    files: string[],
    knownHashes: Record<string, string>
  ): Promise<{ docs: StoredDocument[]; fileHashes: Record<string, string> }> {
    const docs: StoredDocument[] = [];
    const fileHashes: Record<string, string> = {};

    for (const file of files) {
      try {
        const content = await this.storageManager.readFileContent(file);
        const hash = this.hashContent(content);
        fileHashes[file] = hash;
        if (knownHashes[file] === hash) {
          continue; // 文件未变，跳过
        }
        if (Array.isArray(content.documents)) {
          docs.push(...content.documents);
        }
      } catch {
        // 跳过损坏文件
      }
    }
    return { docs, fileHashes };
  }

  private async resolvePullDocument(doc: StoredDocument): Promise<Record<string, any> | null> {
    const existing = await this.db.get(doc._id, { revs: true } as any).catch(() => null);
    if (!existing) {
      debug(`文档 ${doc._id} 是新文档，将添加`);
      return this.prepareDocForLocalWrite(doc);
    }

    const reason = this.compareDocumentRevisions(existing as StoredDocument, doc);
    const decision = await this.resolveIncomingDocument(existing as StoredDocument, doc, reason);

    if (decision.action === 'use-remote') {
      return this.prepareDocForLocalWrite(doc, (existing as any)._rev);
    }
    if (decision.action === 'merge' && decision.doc) {
      return this.prepareDocForLocalWrite(decision.doc, (existing as any)._rev);
    }
    if (decision.action === 'keep-conflict') {
      return this.createConflictDocument(existing as StoredDocument, doc, reason, decision.reason);
    }
    return null; // use-local
  }

  private async applyBulkUpdates(toUpdate: Record<string, any>[]): Promise<void> {
    if (toUpdate.length === 0) {
      debug('没有文档需要更新');
      return;
    }
    const result = await this.db.bulkDocs(toUpdate);
    let ok = 0;
    for (const r of result) {
      if ((r as any).ok) ok++;
      else debugError('写入失败:', r);
    }
    debug(`bulkDocs 完成: ${ok} 成功, ${result.length - ok} 失败`);
  }

  private async saveProcessedHashes(
    fileHashes: Record<string, string>,
    cache: { basePath: string; hashes: Record<string, string> }
  ): Promise<void> {
    for (const [file, hash] of Object.entries(fileHashes)) {
      cache.hashes[file] = hash;
    }
    await this.localCache.setProcessedFiles(cache);
  }

  private async updateRemoteRevCacheFromDocs(docs: StoredDocument[]): Promise<void> {
    const cache = await this.localCache.getRemoteRevCache();
    for (const doc of docs) {
      cache.revs[doc._id] = doc._rev;
    }
    await this.localCache.setRemoteRevCache(cache);
  }

  // ============ PUSH ============

  /**
   * 从 PouchDB 推送到目标文件系统
   */
  private async pushToFiles(): Promise<void> {
    debug('pushToFiles() 开始');

    const lastSeq = await this.getLastPushedSeq();
    if (await this.canSkipPush(lastSeq)) {
      debug('轻量跳过：本地无新变更');
      return;
    }

    const remoteRevs = await this.ensureRemoteRevCache();
    const changed = await this.db.allDocs({ include_docs: true });
    const diffIds = this.filterPushDiff(changed.rows, remoteRevs.revs).map(d => d._id);

    debug('待推送差异文档数量:', diffIds.length);
    if (diffIds.length === 0) {
      await this.saveLastPushedSeq(changed.update_seq as number);
      return;
    }

    // 逐个取出完整文档（含 _revisions），保留变更链供远端二次比对
    const diff: StoredDocument[] = [];
    for (const id of diffIds) {
      const full = await this.db.get(id, { revs: true } as any);
      diff.push(full as StoredDocument);
    }

    await this.storageManager.writeDocuments(diff);
    await this.saveRemoteRevCache(diff, remoteRevs);
    await this.saveLastPushedSeq(changed.update_seq as number);

    debug('pushToFiles() 结束');
  }

  /**
   * 轻量跳过：上次推送 seq === 当前 seq 则无新变更
   */
  private async canSkipPush(lastSeq: number | null): Promise<boolean> {
    if (lastSeq === null) return false;
    const info = await this.db.info();
    return (info.update_seq as number) <= lastSeq;
  }

  /**
   * 读取或（空时）从目标文件系统重建 remote-rev-cache
   */
  private async ensureRemoteRevCache(): Promise<{ basePath: string; revs: Record<string, string> }> {
    const cache = await this.localCache.getRemoteRevCache();
    if (Object.keys(cache.revs).length > 0) {
      return cache;
    }
    debug('remote-rev-cache 为空，从目标文件系统重建');
    return this.buildRemoteRevCacheFromFiles();
  }

  private async buildRemoteRevCacheFromFiles(): Promise<{ basePath: string; revs: Record<string, string> }> {
    const docs = await this.storageManager.readAllDocuments();
    const revs: Record<string, string> = {};
    for (const doc of docs) {
      revs[doc._id] = doc._rev;
    }
    const cache = { basePath: this.options.basePath, revs };
    await this.localCache.setRemoteRevCache(cache);
    return cache;
  }

  /**
   * 按 _rev generation 筛选 push 差异，并用 _revisions/变更链做二次兜底
   */
  private filterPushDiff(
    rows: PouchDB.Core.AllDocsResponse<StoredDocument>['rows'],
    remoteRevs: Record<string, string>
  ): StoredDocument[] {
    const diff: StoredDocument[] = [];
    for (const row of rows) {
      const doc = (row as any).doc as StoredDocument | undefined;
      if (!doc || doc._id.startsWith('_design/') || doc._id.startsWith('_local/')) continue;
      if (this.isNewerThanRemote(doc, remoteRevs)) {
        diff.push(doc);
      }
    }
    return diff;
  }

  private isNewerThanRemote(doc: StoredDocument, remoteRevs: Record<string, string>): boolean {
    const remoteRev = remoteRevs[doc._id];
    if (remoteRev === undefined) return true; // 远端没有 -> 新增
    if (remoteRev === doc._rev) return false; // 一致 -> 跳过

    // 二次兜底：用 _revisions 判断祖先关系，避免误判分叉
    if (doc._revisions && this.revisionsContain(doc, remoteRev)) {
      return false; // doc 是远端版本的祖先（更旧）
    }
    return this.parseRevision(doc._rev)!.generation >= this.parseRevision(remoteRev)!.generation;
  }

  private async saveRemoteRevCache(
    diff: StoredDocument[],
    cache: { basePath: string; revs: Record<string, string> }
  ): Promise<void> {
    for (const doc of diff) {
      cache.revs[doc._id] = doc._rev;
    }
    await this.localCache.setRemoteRevCache(cache);
  }

  // ============ sync-seq 轻量跳过 ============

  private async getLastPushedSeq(): Promise<number | null> {
    const cache = await this.localCache.getSyncSeq();
    return cache.lastPushedSeq;
  }

  private async saveLastPushedSeq(seq: number): Promise<void> {
    await this.localCache.setSyncSeq({ basePath: this.options.basePath, lastPushedSeq: seq });
  }

  // ============ 合并 ============

  /**
   * 启动自动合并
   */
  private startAutoMerge(): void {
    if (this.mergeTimer) return;
    const interval = this.options.mergeCheckInterval || 60000;

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
   * @param force 跳过「上月已合并」标记约束 + 「排除本月文件」过滤，强制合并（含本月 data）。
   *              手动/测试调用应传 true，否则本月 data 被留到下月、且上月已合并时会被标记挡住，无法验证合并逻辑。
   *              自动定时检查不传（走跨时区/多设备去重约束，且只合并上月及更早的 data）。
   */
  async performMerge(force = false): Promise<void> {
    if (this.mergeInProgress) {
      debug('合并已在进行中，跳过');
      return;
    }

    // 跨设备/跨时区去重：上个月的 data 若已有任意一台设备合并过，直接跳过（标记写在共享 WebDAV 上）。
    // force=true（手动/测试）时跳过此约束，便于验证合并逻辑本身。
    if (!force && (await this.storageManager.hasMergedThisMonth())) {
      debug('performMerge: 上月的 data 已在共享存储上合并过（UTC 月），跳过');
      return;
    }

    this.mergeInProgress = true;
    try {
      await this.lockManager.withLock('merge', 'file-merge', async () => {
        // 抢到锁后再确认一次，避免与几乎同时触发的另一台设备重复（竞态收窄窗口）。
        // 同样只在非 force 时检查。
        if (!force && (await this.storageManager.hasMergedThisMonth())) {
          debug('performMerge: 抢锁后发现上月已合并，跳过');
          return;
        }
        const candidates = await this.storageManager.findMergeCandidates(force);
        debug(`performMerge: findMergeCandidates 返回 ${candidates.length} 组候选`);
        if (candidates.length === 0) {
          debug(`performMerge: 无候选可合并（${force ? '无任何 data 文件' : '无上月及更早的 data 文件，或列表为空'}）`);
        }
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

  // ============ 冲突处理工具 ============

  /**
   * 比较两个文档的 revision 关系。
   * 有 _revisions 时优先判断祖先关系；没有完整链时回退到 revision generation。
   */
  private compareDocumentRevisions(localDoc: StoredDocument, remoteDoc: StoredDocument): SyncConflictReason {
    if (localDoc._rev === remoteDoc._rev) return 'same';

    if (remoteDoc._revisions && this.revisionsContain(remoteDoc, localDoc._rev)) {
      return 'remote-newer';
    }

    if (localDoc._revisions && this.revisionsContain(localDoc, remoteDoc._rev)) {
      return 'local-newer';
    }

    const localRev = this.parseRevision(localDoc._rev);
    const remoteRev = this.parseRevision(remoteDoc._rev);
    if (!localRev || !remoteRev) return 'unknown';

    if (localRev.generation === remoteRev.generation && localRev.hash !== remoteRev.hash) {
      return 'conflict';
    }

    if (remoteRev.generation > localRev.generation) return 'remote-newer';
    if (localRev.generation > remoteRev.generation) return 'local-newer';
    return 'unknown';
  }

  private async resolveIncomingDocument(
    localDoc: StoredDocument,
    remoteDoc: StoredDocument,
    reason: SyncConflictReason
  ): Promise<SyncConflictDecision> {
    if (reason === 'same') return { action: 'use-local' };

    if (this.options.conflictResolver) {
      return await this.options.conflictResolver(localDoc, remoteDoc, {
        docId: remoteDoc._id,
        direction: 'pull',
        reason,
        localRev: localDoc._rev,
        remoteRev: remoteDoc._rev,
      });
    }

    if (reason === 'remote-newer') return { action: 'use-remote' };
    if (reason === 'local-newer') return { action: 'use-local' };
    return { action: 'keep-conflict', reason: `unresolved ${reason}` };
  }

  private parseRevision(rev?: string): { generation: number; hash: string } | null {
    if (!rev) return null;
    const match = /^(\d+)-(.+)$/.exec(rev);
    if (!match) return null;
    return {
      generation: parseInt(match[1], 10),
      hash: match[2],
    };
  }

  private revisionsContain(doc: StoredDocument, targetRev?: string): boolean {
    const parsed = this.parseRevision(targetRev);
    const revisions = doc._revisions;
    if (!parsed || !revisions) return false;
    const index = revisions.start - parsed.generation;
    return index >= 0 && index < revisions.ids.length && revisions.ids[index] === parsed.hash;
  }

  private prepareDocForLocalWrite(doc: StoredDocument | Record<string, any>, currentRev?: string): Record<string, any> {
    const { _rev, _revisions, ...rest } = doc as StoredDocument;
    if (currentRev) {
      return { ...rest, _rev: currentRev };
    }
    return rest;
  }

  private createConflictDocument(
    localDoc: StoredDocument,
    remoteDoc: StoredDocument,
    reason: SyncConflictReason,
    decisionReason?: string
  ): Record<string, any> {
    const remoteRev = remoteDoc._rev || 'unknown';
    return {
      _id: `sync_conflict:${encodeURIComponent(remoteDoc._id)}:${encodeURIComponent(remoteRev)}`,
      type: 'sync-conflict',
      docId: remoteDoc._id,
      rev: remoteRev,
      direction: 'pull',
      reason,
      decisionReason,
      localRev: localDoc._rev,
      remoteDoc,
      createdAt: Date.now(),
    };
  }

  // ============ 哈希辅助 ============

  /**
   * 计算文件内容哈希（仅用于 processed-files 跳过未变文件，非密码学用途）。
   * 使用 FNV-1a 32-bit 哈希，跨 Node/浏览器环境确定性一致，且不依赖 Node 内置模块。
   * 最终正确性由 _rev 比较保证，哈希只是性能优化。
   */
  private hashContent(content: { documents: StoredDocument[] }): string {
    const str = JSON.stringify(content.documents);
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    this.stopAutoMerge();
  }
}
