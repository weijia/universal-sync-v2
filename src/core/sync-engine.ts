import PouchDB from 'pouchdb-core';
import {
  IFileSystem,
  StoredDocument,
  SyncConflictDecision,
  SyncConflictReason,
  SyncOptions,
  SyncProgress,
} from '../types.js';
import { StorageManager } from './storage-manager.js';
import { LocalCache } from './local-cache.js';
import { logSyncEngine } from '../utils/logger.js';

const PREFIX = '[SyncEngine]';
const debug = (...args: unknown[]): void => logSyncEngine.log(PREFIX, ...args);
const debugError = (...args: unknown[]): void => logSyncEngine.error(PREFIX, ...args);

/**
 * 一条待写入本地的数据
 *
 * - replicate：远端文档原样复刻（连同 _rev / _revisions / _deleted），用 new_edits:false 写入。
 *   这样两台设备的 rev 完全一致，不会各生成一个 rev 再互相判定成冲突。
 * - edit：本地在既有版本上生成新修订（合并结果 / 冲突归档），用 new_edits:true 写入。
 */
interface PullWrite {
  doc: Record<string, any>;
  mode: 'replicate' | 'edit';
}

/**
 * PouchDB 同步引擎（rev2：基于 _rev 差异，去 manifest / 全局 sequence / 目录重排）
 *
 * - push：轻量跳过 -> 初始化 remote-rev-cache（空则扫文件系统重建）-> 按 _rev generation 筛选差异 -> 二次 compareDocumentRevisions 兜底 -> 写入文件 -> 回写缓存
 * - pull：listAllDataFiles -> processed-files 过滤未变文件 -> compareDocumentRevisions -> bulkDocs -> 回写 remote-rev-cache
 * - 删除：allDocs 不返回已删文档，push 侧必须额外从 changes 收集墓碑；pull 侧用 _revisions 链原样复刻墓碑
 */
export class SyncEngine {
  private storageManager: StorageManager;
  private localCache: LocalCache;
  private syncInProgress = false;
  private mergeInProgress = false;
  private mergeTimer?: ReturnType<typeof setInterval>;

  private emitProgress(progress: SyncProgress): void {
    try {
      this.options.onProgress?.(progress);
    } catch (err) {
      debugError('onProgress 回调抛错（已忽略）:', err);
    }
  }

  constructor(
    private db: PouchDB.Database,
    private fs: IFileSystem,
    private options: SyncOptions
  ) {
    debug('构造函数初始化, basePath:', options.basePath);
    this.storageManager = new StorageManager(fs, options);
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
      await this.pullFromFiles();
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
      await this.pullFromFiles();
      await this.pushToFiles();

      this.emitProgress({ phase: 'done', message: '同步完成' });

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
    this.emitProgress({
      phase: 'pull',
      remoteFilesTotal: files.length,
      remoteFilesRead: 0,
      message: `服务器上有 ${files.length} 个数据文件待读取`,
    });

    const processed = await this.localCache.getProcessedFiles();
    let readCount = 0;
    const { docs, fileHashes } = await this.readChangedDocs(files, processed.hashes, () => {
      readCount++;
      this.emitProgress({
        phase: 'pull',
        remoteFilesTotal: files.length,
        remoteFilesRead: readCount,
        message: `已从服务器读取 ${readCount}/${files.length} 个文件`,
      });
    });
    debug('需处理的文档数量:', docs.length);
    this.emitProgress({
      phase: 'pull',
      remoteFilesTotal: files.length,
      remoteFilesRead: readCount,
      localPendingToApply: docs.length,
      message: `服务器数据读取完成，本地有 ${docs.length} 条记录待写入`,
    });

    const toUpdate: PullWrite[] = [];
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
    knownHashes: Record<string, string>,
    onFileRead?: () => void
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
      onFileRead?.();
    }
    return { docs, fileHashes };
  }

  private async resolvePullDocument(doc: StoredDocument): Promise<PullWrite | null> {
    const existing = await this.db.get(doc._id, { revs: true, conflicts: true } as any).catch(() => null);
    if (!existing) {
      // 本地已无该文档：可能是本地删除过，也可能是从未同步过。
      // 若远端这条也是墓碑，说明两边一致地"没有"，不能再写一条新文档把它复活。
      if ((doc as any)._deleted) {
        debug(`文档 ${doc._id} 本地已不存在，跳过远端墓碑`);
        return null;
      }
      debug(`文档 ${doc._id} 是新文档，将按原 rev 复刻`);
      return { mode: 'replicate', doc: this.prepareDocForReplication(doc) };
    }

    const reason = this.compareDocumentRevisions(existing as StoredDocument, doc);
    const decision = await this.resolveIncomingDocument(existing as StoredDocument, doc, reason);

    if (decision.action === 'use-remote') {
      return { mode: 'replicate', doc: this.prepareDocForReplication(doc) };
    }
    if (decision.action === 'merge' && decision.doc) {
      return { mode: 'edit', doc: this.prepareDocForLocalWrite(decision.doc, (existing as any)._rev) };
    }
    if (decision.action === 'keep-conflict') {
      return { mode: 'edit', doc: this.createConflictDocument(existing as StoredDocument, doc, reason, decision.reason) };
    }
    return null; // use-local
  }

  private async applyBulkUpdates(toUpdate: PullWrite[]): Promise<void> {
    if (toUpdate.length === 0) {
      debug('没有文档需要更新');
      return;
    }

    // 复制语义：原样带 _rev/_revisions 写入，保持两端 rev 一致
    const replicas = toUpdate.filter(w => w.mode === 'replicate').map(w => w.doc);
    if (replicas.length > 0) {
      const result = await this.db.bulkDocs(replicas, { new_edits: false });
      // new_edits:false 时 PouchDB 成功不返回条目；返回的条目是错误
      const errors = (result as any[]).filter(r => r && (r as any).error);
      debug(`new_edits:false 复刻 ${replicas.length} 条，异常 ${errors.length} 条`);
      for (const e of errors) debugError('复刻失败:', e);
    }

    // 编辑语义：合并结果 / 冲突归档，走本地新修订
    const edits = toUpdate.filter(w => w.mode === 'edit').map(w => w.doc);
    if (edits.length > 0) {
      const result = await this.db.bulkDocs(edits);
      let ok = 0;
      for (const r of result) {
        if ((r as any).ok) ok++;
        else debugError('写入失败:', r);
      }
      debug(`bulkDocs 完成: ${ok} 成功, ${result.length - ok} 失败`);
    }
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
    // 必须显式 update_seq:true，否则 allDocs 不返回 update_seq，轻量跳过形同虚设
    const changed = await this.db.allDocs({ include_docs: true, update_seq: true });
    const diffIds = this.filterPushDiff(changed.rows, remoteRevs.revs).map(d => d._id);

    // allDocs 默认不返回已删除文档，删除在 push 侧完全不可见，
    // 必须另外从 changes 里捞墓碑，否则删除永远不会传播到远端。
    // 远端已经是同一个墓碑 rev 的跳过，避免接收端把刚拉下来的墓碑再推一遍。
    const tombstones = (await this.collectLocalDeletions(lastSeq)).filter(
      t => remoteRevs.revs[t._id] !== t._rev
    );

    debug('待推送差异文档数量:', diffIds.length, '待推送墓碑数量:', tombstones.length);
    if (diffIds.length === 0 && tombstones.length === 0) {
      this.emitProgress({ phase: 'skip', message: '本地无新变更，无需上传' });
      await this.saveLastPushedSeq(changed.update_seq as number);
      return;
    }

    // 逐个取出完整文档（含 _revisions），保留变更链供远端二次比对
    const diff: StoredDocument[] = [];
    for (const id of diffIds) {
      const full = await this.db.get(id, { revs: true } as any);
      diff.push(full as StoredDocument);
    }
    // 同一 id 不会既在 diffIds 又在 tombstones 里（allDocs 已过滤掉删除态），
    // 这里仍做一次去重，防止适配器实现差异导致重复写入。
    for (const t of tombstones) {
      if (!diff.some(d => d._id === t._id)) diff.push(t);
    }

    this.emitProgress({
      phase: 'push',
      localDocsTotal: diff.length,
      localFilesWritten: 0,
      message: `本地有 ${diff.length} 条记录待上传`,
    });

    await this.storageManager.writeDocuments(diff, (written, total) => {
      this.emitProgress({
        phase: 'push',
        localDocsTotal: diff.length,
        localFilesTotal: total,
        localFilesWritten: written,
        message: `已上传 ${written}/${total} 个文件`,
      });
    });
    await this.saveRemoteRevCache(diff, remoteRevs);
    await this.saveLastPushedSeq(changed.update_seq as number);

    debug('pushToFiles() 结束');
  }

  /**
   * 收集自 lastSeq 以来本地被删除的文档，转成墓碑（_deleted: true）。
   *
   * 为什么不能只靠 allDocs：PouchDB 的 allDocs 默认不返回已删除文档，
   * 删除这条变更不会出现在 rows 里，push 侧因此永远看不到删除。
   * 只有 changes（带 include_docs）会给出 { _id, _rev, _deleted: true }。
   *
   * 适配器没有 changes 方法时（如 memory-pouch 精简适配器）返回空数组，
   * 保持向后兼容，不改变原有行为。
   */
  private async collectLocalDeletions(lastSeq: number | null): Promise<StoredDocument[]> {
    const changes = (this.db as any).changes;
    if (typeof changes !== 'function') {
      debug('当前 db 适配器不支持 changes，跳过删除收集');
      return [];
    }

    const res = await changes.call(this.db, { since: lastSeq ?? 0, include_docs: true });
    const tombstones: StoredDocument[] = [];
    for (const row of ((res && res.results) || []) as any[]) {
      const rev: string | undefined = row?.changes?.[0]?.rev ?? row?.doc?._rev;
      const isDeleted = row?.deleted === true || row?.doc?._deleted === true;
      if (!row?.id || !rev || !isDeleted) continue;
      if (row.id.startsWith('_design/') || row.id.startsWith('_local/')) continue;
      // 墓碑必须带 _revisions 链，否则对端 new_edits:false 会静默忽略、删不掉任何东西
      let tomb: StoredDocument = { _id: row.id, _rev: rev, _deleted: true } as StoredDocument;
      try {
        const full = await this.db.get(row.id, { rev, revs: true } as any);
        if ((full as any)._revisions) tomb = full as StoredDocument;
      } catch {
        // 取不到完整链就退回最小墓碑，由复制端合成 _revisions
      }
      tombstones.push(tomb);
    }
    debug('changes 中发现的本地删除数量:', tombstones.length);
    return tombstones;
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
   *
   * 不加跨进程文件锁：合并是幂等的（按 _rev 去重），两台设备同时合并最坏只多一个 merged 文件。
   * 同一实例内靠 mergeInProgress / syncInProgress 串行，避免"合并移动源文件"与"拉取读源文件"交叉。
   */
  async performMerge(force = false): Promise<void> {
    if (this.mergeInProgress || this.syncInProgress) {
      debug('合并或同步已在进行中，跳过');
      return;
    }

    // 先置位再 await：两个并发调用不会都通过上面的检查（无竞态窗口）
    this.mergeInProgress = true;
    try {
      // 跨设备/跨时区去重：上个月的 data 若已有任意一台设备合并过，直接跳过（标记写在共享 WebDAV 上）。
      // force=true（手动/测试）时跳过此约束，便于验证合并逻辑本身。
      if (!force && (await this.storageManager.hasMergedThisMonth())) {
        debug('performMerge: 上月的 data 已在共享存储上合并过（UTC 月），跳过');
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

  /**
   * 复制语义用：远端文档原样返回，_rev / _revisions / _deleted 全部保留。
   *
   * 必须带 _revisions：PouchDB 的 new_edits:false 在没有 _revisions 时会静默忽略整条写入
   * （不报错、bulkDocs 返回空数组），文档看似"同步过"其实没落库。
   * 缺 _revisions 时按 _rev 合成最小链，保证一定落在正确的代次上。
   */
  private prepareDocForReplication(doc: StoredDocument): Record<string, any> {
    const out: Record<string, any> = { ...doc };
    if (out._rev && !out._revisions) {
      const gen = this.parseRevision(out._rev);
      if (gen) out._revisions = { start: gen.generation, ids: [gen.hash] };
    }
    return out;
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
