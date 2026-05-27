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
2. 读取或创建清单文件（`manifest.json`）
3. 验证存储版本兼容性

### 2. Pull 阶段：从文件加载到 PouchDB

```typescript
// src/core/sync-engine.ts
private async loadFromFiles(): Promise<void> {
  // 获取 PouchDB 当前的更新序列号
  const info = await this.db.info();
  const localSeq = info.update_seq as number || 0;

  // 读取清单中记录的最后序列号
  const remoteLastSeq = await this.storageManager.getLastSequence();
  
  // 决定读取策略
  let documents: StoredDocument[] = [];
  if (localSeq === 0) {
    // 首次同步：读取所有文档
    documents = await this.storageManager.readAllDocuments();
  } else if (localSeq > remoteLastSeq) {
    // 本地比远端新：执行完整拉取
    documents = await this.storageManager.readAllDocuments();
  } else {
    // 增量同步：只读取新文件
    documents = await this.storageManager.readIncrementalDocuments(localSeq);
  }

  // 批量更新到 PouchDB（带版本比较）
  const docsToUpdate: any[] = [];
  for (const doc of documents) {
    try {
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
```

**关键步骤：**
1. 获取本地 PouchDB 的当前序列号
2. 与文件存储的序列号比较
3. 决定是完整读取还是增量读取
4. 对每个文档进行版本比较
5. 批量更新到 PouchDB

### 3. Push 阶段：从 PouchDB 保存到文件

```typescript
// src/core/sync-engine.ts
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

  // 写入文件（带分片和清单更新）
  await this.storageManager.writeDocuments(documents);
}
```

**关键步骤：**
1. 读取 PouchDB 中的所有文档
2. 过滤掉设计文档（`_design/` 开头）
3. 调用 StorageManager 写入文件

### 4. 文件写入过程

```typescript
// src/core/storage-manager.ts
async writeDocuments(documents: StoredDocument[]): Promise<void> {
  // 1. 读取现有文档进行版本比较
  const existing = this.manifestManager ? await this.readAllDocuments() : [];
  const existingMap = new Map<string, string | undefined>();
  for (const d of existing) {
    existingMap.set(d._id, d._rev);
  }

  // 2. 过滤出比现有版本更新的文档
  const toWrite = documents.filter(doc => {
    const existingRev = existingMap.get(doc._id);
    if (!existingRev) return true;
    if (!doc._rev) return true;
    return this.isNewerRev(doc._rev, existingRev);
  });

  if (toWrite.length === 0) return;

  // 3. 按文件大小限制分片
  let sequence = await this.getLastSequence() + 1;
  const timestamp = Date.now();
  const chunks = this.chunkDocuments(toWrite);
  
  for (const chunk of chunks) {
    const filename = this.generateDataFilename(sequence, timestamp);
    
    // 4. 使用年/月分区目录
    const date = new Date(timestamp);
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const partition = `${year}/${month}`;
    const partitionDir = this.fsUtils.joinPath(this.dataDir, partition);
    await this.fsUtils.ensureDir(partitionDir);

    const filePath = this.fsUtils.joinPath(partitionDir, filename);

    // 5. 写入数据文件
    const content: DataFileContent = {
      version: STORAGE_VERSION,
      timestamp,
      sequence,
      documents: chunk,
    };
    await this.fsUtils.writeJSON(filePath, content);

    // 6. 更新清单
    const metadata: DataFileMetadata = {
      filename,
      startSeq: sequence,
      endSeq: sequence,
      timestamp,
      documentCount: chunk.length,
      partition,
    };

    if (this.manifestManager) {
      await this.manifestManager.addFile(metadata);
    }
    sequence++;
  }
}
```

**关键步骤：**
1. 版本比较：只写入更新的文档
2. 分片：按大小限制将文档分批
3. 分区存储：按年/月组织目录
4. 原子写入：确保文件写入的完整性
5. 更新清单：记录文件元数据

### 5. 文件合并阶段（可选）

```typescript
// src/core/sync-engine.ts
async performMerge(): Promise<void> {
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
}
```

**合并条件：**
- 文件大小小于阈值（默认 100KB）
- 序列号连续
- 未被标记为已合并

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
│     ├─ 读取 manifest.json 获取最后序列号                         │
│     ├─ 比较本地 DB 序列号                                        │
│     ├─ 决定读取策略（全量/增量）                                  │
│     ├─ 读取数据文件                                              │
│     ├─ 版本比较（_rev 字段）                                     │
│     └─ bulkDocs() 批量更新                                       │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. PUSH 阶段：PouchDB → 文件                                    │
│     ├─ allDocs() 读取所有文档                                    │
│     ├─ 版本比较（避免重复写入）                                   │
│     ├─ 按大小分片                                                │
│     ├─ 生成文件名和分区路径                                       │
│     ├─ 写入数据文件（原子操作）                                   │
│     └─ 更新 manifest.json                                        │
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
│     ├─ 识别可合并的小文件组                                       │
│     ├─ 读取并合并文档（去重）                                     │
│     ├─ 写入合并文件到 merged/                                    │
│     ├─ 更新清单（标记源文件为 archived）                          │
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
// src/core/sync-engine.ts
private isNewerVersion(rev1: string, rev2: string): boolean {
  const seq1 = parseInt(rev1.split('-')[0], 10);
  const seq2 = parseInt(rev2.split('-')[0], 10);
  return seq1 > seq2;
}
```

PouchDB 的版本号格式：`{sequence}-{hash}`
- 序列号越大表示版本越新
- 同步时始终保留最新版本

### 文件序列号

每个数据文件有一个全局递增的序列号：
- 用于标识文件的时间顺序
- 用于增量同步
- 记录在 `manifest.json` 的 `lastSequence` 字段

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
├── manifest-index.json        # 全局分区索引
├── data/                      # 原始数据文件（按年月分区）
│   └── 2026/
│       └── 03/
│           ├── manifest.json  # 分区清单
│           ├── data-1-2026-03-12T10-00-00-000Z.json
│           └── data-2-2026-03-12T10-05-00-000Z.json
└── merged/                    # 合并后的文件
    └── 2026/
        └── 03/
            └── merged-1-2-2026-03-12T11-00-00-000Z.json
```

## 使用示例

### 基本同步

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

const db = new PouchDB('mydb');

// 添加数据到 PouchDB
await db.put({ _id: 'user:1', name: 'Alice' });

// 同步到文件系统
await sync(db, fs, './storage');
```

### 手动控制同步引擎

```typescript
import { SyncEngine } from 'universal-sync-v2';

const engine = new SyncEngine(db, fs, {
  basePath: './storage',
  autoMerge: true,
  mergeInterval: 60000,
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

1. **PouchDB 存储后端**：PouchDB 可以使用多种存储后端（IndexedDB、LevelDB 等），但 universal-sync-v2 只负责 PouchDB 与 JSON 文件之间的同步。

2. **版本冲突**：当同一文档在 PouchDB 和文件存储中都有更新时，系统会比较 `_rev` 字段，保留版本号较大的（即更新的）。

3. **增量同步**：系统通过序列号实现增量同步，减少不必要的数据传输。

4. **原子性**：文件写入使用临时文件+重命名的方式确保原子性。

5. **锁超时**：分布式锁有默认 30 秒超时，防止死锁。
