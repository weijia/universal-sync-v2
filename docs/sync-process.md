# 文件同步到 PouchDB 过程详解

本文档详细描述了 universal-sync-v2 如何将 JSON 文件存储与 PouchDB 进行双向同步的过程。

## 概述

Universal Sync V2 实现了 PouchDB 与基于 JSON 文件的存储系统之间的双向同步。它不是直接同步到 SQLite 数据库，而是通过 PouchDB 的抽象层来管理数据，PouchDB 本身可以使用多种存储后端（如 IndexedDB、LevelDB、WebSQL 等）。

## 同步架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      同步流程架构                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐         sync()          ┌──────────────────┐ │
│  │   PouchDB    │ ◄──────────────────────► │   JSON Files     │ │
│  │  (内存/本地)  │    双向同步              │  (文件系统存储)   │ │
│  └──────┬───────┘                         └────────┬─────────┘ │
│         │                                          │           │
│         ▼                                          ▼           │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    SyncEngine                           │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │  │
│  │  │  Pull Phase │  │  Push Phase │  │   Merge Phase   │  │  │
│  │  │ (文件→DB)   │  │ (DB→文件)   │  │  (文件合并)     │  │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 同步流程详解

### 1. 初始化阶段

```typescript
// src/core/sync-engine.ts
async initialize(): Promise<void> {
  await this.storageManager.initialize();
}
```

初始化时：
1. 创建存储目录结构（`data/`、`merged/`）
2. **不再读取/创建 manifest.json**（rev2 设计）
3. 验证存储版本兼容性（数据文件 `version` 字段）

### 2. Pull 阶段：从文件加载到 PouchDB

```typescript
// src/core/sync-engine.ts
private async loadFromFiles(): Promise<void> {
  // 1. 递归列出 data/ + merged/ 下所有 *.json
  const files = await this.storageManager.listAllDataFiles();

  // 2. 读 _local/sync-processed-files，按 contentHash 过滤出"需读取"的文件
  const processed = await this.getLocalDoc('sync-processed-files');
  const pending = files.filter(f => processed.files[f] !== hashOf(f));

  // 3. 读取待处理文件，对每个 doc 与本地 PouchDB 用 compareDocumentRevisions 比较
  const docsToUpdate: any[] = [];
  for (const file of pending) {
    const docs = await this.storageManager.readDataFile(file);
    for (const doc of docs) {
      const decision = await this.resolveIncomingDocument(doc); // remote-newer / conflict / local-newer
      if (decision.action === 'use-remote') docsToUpdate.push(doc);
      else if (decision.action === 'keep-conflict') docsToUpdate.push(decision.doc);
    }
    // 更新 processed-files[file] = hashOf(file)
  }

  if (docsToUpdate.length > 0) {
    await this.db.bulkDocs(docsToUpdate);
  }

  // 4. 用文件里每个 doc 的最新 _rev 回写 remote-rev-cache（与 push 共用）
  await this.refreshRemoteRevCache(docsToUpdate);
}
```

**关键步骤：**
1. 列目录发现文件（不再读 manifest）
2. 用 `processed-files` 的 contentHash 跳过未变文件
3. 对每个文档做 `_rev` 比较（remote-newer 应用、conflict 保留冲突文档、local-newer 不动；`_deleted` 也走同一路径）
4. bulkDocs 批量更新
5. 回写 `remote-rev-cache`

### 3. Push 阶段：从 PouchDB 保存到文件（基于 `_rev` 差异）

```typescript
// src/core/sync-engine.ts
private async saveToFiles(): Promise<void> {
  // 0. 轻量跳过：本地无变更则直接返回（保留 update_seq 优化，不依赖 manifest）
  const info = await this.db.info();
  const currentSeq = info.update_seq as number || 0;
  const lastPushedSeq = (await this.getLocalDoc('sync-seq'))?.lastPushedSeq || 0;
  if (currentSeq <= lastPushedSeq) return;

  // 1. 确保 remote-rev-cache 已初始化（为空则扫目标文件系统重建）
  let cache = await this.getLocalDoc('sync-remote-rev');
  if (!cache || Object.keys(cache.revs).length === 0) {
    cache = await this.buildRemoteRevCacheFromFiles(); // 扫 data/ + merged/ 取每个 doc 最新 _rev
  }

  // 2. 取本地所有 doc（含 tombstone！必须 include_docs 拿到 _deleted）
  const result = await this.db.allDocs({ include_docs: true });
  const localDocs = result.rows
    .filter(r => r.doc && !r.id.startsWith('_design/'))
    .map(r => r.doc);

  // 3. 按 _rev 差异筛选"需推送"的 doc
  const toPush = localDocs.filter(d => {
    const remoteRev = cache.revs[d._id];
    if (!remoteRev) return true;                       // 远端不存在
    return gen(d._rev) > gen(remoteRev);               // 本地更新
  });

  // 4. 对 toPush 再与目标文件真实内容 compareDocumentRevisions 一次（防 cache 漂移）
  const confirmed = toPush.filter(d => this.confirmNewerThanFile(d));

  if (confirmed.length === 0) {
    await this.setLocalDoc('sync-seq', { lastPushedSeq: currentSeq });
    return;
  }

  // 5. 仅把 confirmed 写入一个新 data 文件（一次 push 一个 data-{timestamp}.json）
  await this.storageManager.writeDocuments(confirmed);

  // 6. 回写 cache + 更新轻量跳过游标
  for (const d of confirmed) cache.revs[d._id] = d._rev;
  await this.setLocalDoc('sync-remote-rev', cache);
  await this.setLocalDoc('sync-seq', { lastPushedSeq: currentSeq });
}
```

**关键步骤：**
1. 轻量跳过（`update_seq` 无变化直接返回）
2. **push 前先初始化 `remote-rev-cache`**（为空则扫目标文件系统重建——这是正确增量的前提）
3. 取本地所有 doc（含 tombstone）
4. 按 `_rev` generation 差异筛选（删除文档因 `_rev` 变新自然被选中，无需特殊分支）
5. 二次 `compareDocumentRevisions` 兜底
6. 仅写差异集 + 回写缓存

### 4. 文件写入过程（差异集写入）

```typescript
// src/core/storage-manager.ts
async writeDocuments(documents: StoredDocument[]): Promise<void> {
  if (documents.length === 0) return;

  // 写入即分片：按 maxFileSize 把差异集拆成多个 chunk，每个 chunk 直接写入对应日期子目录
  const timestamp = Date.now();
  const chunks = this.chunkDocuments(documents, this.maxFileSize); // 单文件不超 maxFileSize

  for (const chunk of chunks) {
    // 由 chunk 内文档的 timestamp 决定 data/YYYY/MM/DD 子目录（写入即分片）
    const shardDir = this.shardDirForTimestamp(timestamp);
    const filename = `data-${formatTimestamp(timestamp)}.json`;
    const filePath = this.fsUtils.joinPath(this.dataDir, shardDir, filename);

    const content: DataFileContent = {
      version: STORAGE_VERSION,
      timestamp,
      documents: chunk,          // 注意：无 sequence 字段
    };
    await this.fsUtils.writeJSON(filePath, content);  // 原子写入（临时文件+重命名）
  }
}
```

**关键步骤：**
1. 接收的是**已筛选的差异集**（非全量）
2. 文件名用 timestamp（无 sequence）
3. 原子写入确保完整性
4. **不再更新任何 manifest**

### 5. 文件合并阶段（可选）

```typescript
// src/core/sync-engine.ts
async performMerge(): Promise<void> {
  await this.lockManager.withLock('merge', 'file-merge', async () => {
    const candidates = await this.storageManager.getMergeCandidates();

    for (const group of candidates) {
      try {
        await this.storageManager.mergeFiles(group);
        // 合并后清理源 data 文件 + 从 processed-files 移除其条目
        console.log(`Merged ${group.length} files`);
      } catch (error) {
        console.error('Failed to merge files:', error);
      }
    }
  });
}
```

**合并条件（rev2）：**
- 文件大小小于阈值（默认 100KB）
- 同目录（或同分区）内的小文件，不再要求序列号连续
- 合并后删除/归档源 data 文件，避免历史文件成为永久"死重"

## 数据流图示

### 完整同步流程

```
┌─────────────────────────────────────────────────────────────────┐
│                        同步开始                                  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. 获取分布式锁 (.sync.lock)                                    │
│     - 防止并发同步冲突                                           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. PULL 阶段：文件 → PouchDB                                    │
│     ├─ 列目录 data/ + merged/ 发现文件（不读 manifest）          │
│     ├─ 用 processed-files 的 contentHash 跳过未变文件             │
│     ├─ 读取待处理文件                                            │
│     ├─ _rev 比较（compareDocumentRevisions）                     │
│     ├─ bulkDocs() 批量更新（含 _deleted 删除、冲突保留）          │
│     └─ 回写 remote-rev-cache                                     │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. PUSH 阶段：PouchDB → 文件                                    │
│     ├─ update_seq 轻量跳过（无变更直接返回）                      │
│     ├─ 初始化 remote-rev-cache（为空则扫文件系统重建）            │
│     ├─ allDocs({include_docs}) 读取所有文档（含 tombstone）       │
│     ├─ 按 _rev 差异筛选需推送的 doc                              │
│     ├─ 二次 compareDocumentRevisions 兜底                        │
│     ├─ 写入差异集到 data-{timestamp}.json（原子操作）             │
│     └─ 回写 remote-rev-cache + update_seq 游标                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. 释放分布式锁                                                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. 自动合并（如启用）                                           │
│     ├─ 获取合并锁 (.merge.lock)                                  │
│     ├─ 识别同目录可合并的小文件组（不再要求序列号连续）           │
│     ├─ 读取并合并文档（按 _rev 去重）                             │
│     ├─ 写入合并文件到 merged/                                    │
│     ├─ 删除/归档源 data 文件 + 清理 processed-files 条目          │
│     └─ 释放合并锁                                                │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                        同步完成                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 版本控制机制

### 文档版本比较

```typescript
// src/core/sync-engine.ts（沿用既有 compareDocumentRevisions）
private isNewerVersion(rev1: string, rev2: string): boolean {
  const gen1 = parseInt(rev1.split('-')[0], 10);
  const gen2 = parseInt(rev2.split('-')[0], 10);
  return gen1 > gen2;
}
```

PouchDB 的版本号格式：`{generation}-{hash}`
- `generation` 越大表示版本越新（即文档的"第几代"）
- 同步时始终保留最新版本（`_rev` generation 最大者）
- **不再使用文件级全局 sequence**；版本完全由每个文档自己的 `_rev` 表达

### 无文件序列号（rev2 变更）

rev2 设计**取消了数据文件 / manifest 的全局序列号**：
- 文件命名与内容中均无 `sequence` / `startSeq` / `endSeq`
- "写到第几代"由每个文档 `_rev.generation` 表达
- 增量同步由 `_local` 缓存驱动（见 `sync-design-rev2.md`），而非序列号区间

## 并发控制

### 分布式锁实现

```typescript
// src/core/lock-manager.ts
async withLock<T>(
  lockName: string,
  operation: string,
  callback: () => Promise<T>
): Promise<T> {
  const lockId = await this.acquireLock(lockName, operation);
  try {
    return await callback();
  } finally {
    await this.releaseLock(lockName, lockId);
  }
}
```

锁类型：
- `.sync.lock`：同步操作锁
- `.merge.lock`：文件合并锁

## 存储结构

```
storage-root/
├── data/                      # 原始数据文件（可含任意分区子目录，无 manifest）
│   └── 2026/
│       └── 03/
│           ├── data-2026-03-12T10-00-00-000Z.json
│           └── data-2026-03-12T10-05-00-000Z.json
└── merged/                    # 合并后的文件（无 manifest）
    └── 2026/
        └── 03/
            └── merged-2026-03-12T11-00-00-000Z.json
```
> 本地缓存（`remote-rev-cache` / `processed-files` / `lastPushedSeq`）位于 PouchDB 的 `_local` 文档，不在此目录中。

## 使用示例

### 基本同步

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

const db = new PouchDB('mydb');

// 添加数据到 PouchDB
await db.put({ _id: 'user:1', name: 'Alice' });

// 同步到文件系统（首次会扫文件系统初始化 remote-rev-cache）
await sync(db, fs, './storage');
```

### 手动控制同步引擎

```typescript
import { SyncEngine } from 'universal-sync-v2';

const engine = new SyncEngine(db, fs, {
  basePath: './storage',
  autoMerge: true,
  mergeCheckInterval: 60000,
});

// 初始化
await engine.initialize();

// 仅从文件加载（Pull Only）
await engine.pull();

// 完整同步（Pull + Push）
await engine.sync();

// 手动触发合并
await engine.performMerge();

// 清理资源
await engine.cleanup();
```

## 注意事项

1. **PouchDB 存储后端**：PouchDB 可以使用多种存储后端（IndexedDB、LevelDB 等），但 universal-sync-v2 只负责 PouchDB 与 JSON 文件之间的同步。两个本地缓存存于 PouchDB 的 `_local` 文档，只要 db 是持久化 adapter 即跨端兼容；内存版 db 缓存重启即丢，但会安全退化为全量比对。

2. **版本冲突**：当同一文档在 PouchDB 和文件存储中都有更新时，系统会比较 `_rev` 字段（按 generation），保留版本号较大的（即更新的）。generation 相同但 hash 不同视为分叉冲突，由 `keep-conflict` 生成 `sync_conflict:*` 文档。

3. **增量同步**：rev2 设计下通过两个 `_local` 缓存实现增量——`remote-rev-cache`（push 差异筛选）与 `processed-files`（pull 跳过未变文件），不再依赖全局序列号。

4. **删除传递**：本地删除文档会生成新 `_rev` 的 tombstone（`_deleted:true`），因 `_rev` 变新自然被 push 选中；pull 侧判为 remote-newer 后同步删除。无需特殊删除逻辑。

5. **原子性**：文件写入使用临时文件+重命名的方式确保原子性。

6. **锁超时**：分布式锁有默认 30 秒超时，防止死锁。
