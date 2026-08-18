# 存储格式

> 本文件描述的是 **rev2 设计**（见 `sync-design-rev2.md`）：**无 manifest、无全局 sequence**，文件发现靠列目录，版本判据靠文档自身 `_rev`。

## 目录结构

存储目录不再包含任何 `manifest.json` / `manifest-index.json`。文件发现通过递归列出 `data/` 与 `merged/` 下的 `*.json` 完成。分区目录（如按年/月/日）仍可用，仅作人工查找用途，不再由元数据驱动。

> **当前实现**：`data/` 强制采用「写入即分片」——新文件在写入时直接落到 `data/YYYY/MM/DD/`（按日期分区，便于审计某天的数据）。`merged/` 按年份分区 `merged/YYYY/`（每月只产出 1 个合并文件，一年至多 12 个，无需更细分层）；`merged/` 根目录仅保留 `merged-up-to-*.json` / `.last-merge-*.json` 月份标记，见下节。合并成功后 `data/` 下被移空的日期分片子目录会被自动清理，避免空目录累积。

```
storage-root/
├── data/                      # 原始数据文件（可含任意分区子目录）
│   ├── 2026/
│   │   ├── 03/
│   │   │   ├── 12/
│   │   │   │   ├── data-2026-03-12T10-00-00-000Z.json
│   │   │   │   ├── data-2026-03-12T10-05-00-000Z.json
│   │   │   │   └── ...
│   │   │   └── 11/
│   │   │       └── ...
│   │   └── ...
│   └── ...
└── merged/                    # 合并文件（按年份分区，每月 1 个）
  ├── 2026/
  │   ├── merged-2026-03-12T11-00-00-000Z.json
  │   ├── merged-2026-08-15T11-00-00-000Z.json
  │   └── ...
  └── ...
```

说明：

- **无 `manifest.json`**：不再有全局或分区清单文件，文件列表由目录扫描得到。
- **无全局 sequence**：文件命名与内容中均不含 `startSeq/endSeq/sequence` 字段，版本完全由文档的 `_rev` 决定。
- 分区目录层级非强制（可按 `year/month`、`year/month/day` 或任意规则），仅供人工浏览；同步逻辑对所有 `*.json` 一视同仁。
- 本地缓存（`remote-rev-cache`、`processed-files`、`lastPushedSeq`）存于 PouchDB 的 `_local` 文档，**不写入目标文件系统**。

### 可选：目录分片 — 年/月/日（推荐，便于人工查找）

为了便于人工查找（例如审计、手动恢复或浏览历史），`data/` 推荐使用按日期分层的目录结构 `data/YYYY/MM/DD/`，查找某一天的数据非常直观；`merged/` 按年份分区 `merged/YYYY/`（每月仅产出 1 个合并文件，年份目录即足够），`merged/` 根目录另放月份标记文件。

示例：

```
storage-root/
├── data/
│   ├── 2026/
│   │   ├── 03/
│   │   │   ├── 12/
│   │   │   │   ├── data-2026-03-12T10-00-00-000Z.json
│   │   │   │   ├── data-2026-03-12T10-05-00-000Z.json
│   │   │   │   └── ...
│   │   │   └── 11/
│   │   │       └── ...
│   │   └── ...
│   └── ...
└── merged/
    └── 2026/03/12/merged-2026-03-12T11-00-00-000Z.json
```

设计要点：

- 分片键使用**文件创建时间戳（timestamp）**，按 UTC 年/月/日划分子目录。写入时以文件的 `timestamp` 决定目标年月日路径。
- 文件名已含相对完整时间戳（如 `data-2026-03-12T10-00-00-000Z.json`，**不含序列号**），可直接放入对应日期子目录。
- 读取与写入时需使用 `FileSystemUtils.joinPath(basePath, filename)`，确保支持包含子目录的相对路径。
- **文件发现靠列目录**（递归 `data/` + `merged/`），不依赖任何 manifest。

迁移与兼容：

- 启用新策略时，新的数据文件将写入日期目录，而旧文件仍保留在根 `data/` 或 `merged/` 下；读写逻辑按相对路径 `joinPath` 即可，无需 manifest。
- rev2 下旧版含 `manifest.json` 的数据目录仍可读（按文件名直接读 `documents[]`，`_rev` 比较逻辑不变），可逐步迁移或并行存在。
- 如需整理，可提供迁移脚本将旧文件按文件创建时间搬移到相应日期目录；无需再维护 manifest。

优点：

- 人工查找友好：按年/月/日定位文件非常直观。 
- 自然时间分区，便于按时间窗口归档或清理（例如按月归档）。

折衷与注意点：

- 可能导致小目录（每天的目录）中文件较少，但这符合按时间切分的设计初衷；如果某一天写入量极大，可结合每日内次级分片（例如小时或按计数）扩展。 
- 需要确保 `FileSystem` 后端对频繁创建子目录的性能可接受（在 WebDAV 或对象存储上需验证）。

实现步骤（建议）：

1. 在 `StorageManager.writeDocuments()` 中使用写入文件的 `timestamp` 计算目标目录 `data/YYYY/MM/DD`，并 `fs.mkdir(..., { recursive: true })` 确保目录存在；合并文件在 `mergeFiles()` 中写到 `merged/YYYY/`（按年份）。
2. 生成文件名（采用 `data-{timestamp}.json`，**不含 sequence**），将其放入子目录直接写入。  
3. 确保 `FileSystemUtils.readJSON` / `fsUtils.joinPath` 能正确处理带子目录的 `filename`。  
4. 更新并新增测试，验证写入路径、读取、合并场景（注意已无 manifest 写入）。

如果你确认按年/月/日的方案，我会按上面步骤修改 `StorageManager` 并添加测试；如果你希望混合策略（例如每日日志外再按计数分片），也可以在这里讨论并确定具体规则。

## 写入即分片（Write-time Sharding）

> rev2 设计采用**写入即分片**：`data/` 新文件在写入时直接落到对应日期子目录 `data/YYYY/MM/DD/`，`merged/` 合并文件落到年份目录 `merged/YYYY/`；不先写根目录、不再有"先写根目录再重排"的两阶段机制（该旧机制已废弃，见下方说明）。

### 分片规则

1. **目录分片（按时间）**：`data/` 以文件的 `timestamp` 计算 UTC 年/月/日，写入 `data/YYYY/MM/DD/`；`merged/` 仅按年份分区写入 `merged/YYYY/`（`mkdir(..., { recursive: true })` 确保目录存在）。merged 每月至多产出 1 个文件，年份目录足够，无需更细分层。
2. **单文件体积上限（按大小）**：保留 `maxFileSize`（默认 2MB）作为**单文件体积上限**。一次 push 的差异集若超过 `maxFileSize`，则拆成多个 `data-{timestamp}.json` 写入（多个文件共享同一 timestamp 或递增毫秒均可，靠 `_rev` 决定版本，文件名顺序无关紧要）；否则只产出一个文件。
3. **文件名不含 sequence**：`data-{timestamp}.json` / `merged-{timestamp}.json`，仅靠 timestamp 区分。

```
写入流程（rev2）：
1. 计算差异集
2. 按 maxFileSize 把差异集切成若干 chunk（单文件不超上限）
3. 每个 chunk 直接写入 data/YYYY/MM/DD/data-{timestamp}.json（写入即分片）
4. 读取/合并靠递归列目录，不依赖 manifest
```

### 与旧"目录重排机制"的关系

- rev2 **废弃**了先写根目录、再由 `StorageManager.reorganize()` 统一迁移到分区目录的两阶段方案（`autoReorganize` / `reorgThreshold` / `maxFilesPerDirectory` 等配置不再使用）。
- 旧方案在写入时需要额外一次重排扫描与批量移动，并依赖分布式锁；rev2 改为写入即分片后，目录结构在写入时就已一致，无需后期重排，逻辑更简单。
- 仍需控制单目录文件数量时，由 `maxFileSize` 自然约束（单文件体积越大、文件数越少）；若某日写入量极大，可在 `YYYY/MM/DD` 下扩展小时级或按计数次级分片。

## 分区 Manifest（已废弃，rev2 设计）

> **rev2 设计已取消所有 manifest**（单一 `manifest.json` 与分区 manifest 均不再使用）。
> 文件发现改为递归列目录 `data/**/*.json` 与 `merged/**/*.json`，不再依赖任何索引文件。
> 原"分区 manifest / 全局索引"用于大规模场景下的元数据规模控制，其能力现由以下方式替代：
> - **读取定位**：列目录 + `processed-files` 的 `contentHash` 跳过未变文件（见 `sync-design-rev2.md`）。
> - **合并候选**：按文件大小 / 数量阈值在 `data/` 内计算，不再依赖连续性 sequence。
> - **并发控制**：仍由 `LockManager` 的分布式锁（`.sync.lock` / `.merge.lock`）保证。
>
> 保留此节仅作历史参考；新实现不应再引入 `ManifestManager`。

## 文件格式

> rev2 设计下**不再有清单文件（manifest.json）**，也不再有全局 `sequence`。版本完全由文档自身 `_rev` 决定。

### 数据文件 (data-*.json)

数据文件包含实际的文档数据，文件名用时间戳，不含序列号。

```json
{
  "version": "2.0.0",
  "timestamp": 1704096000000,
  "documents": [
    {
      "_id": "user:123",
      "_rev": "1-abc123def456",
      "type": "user",
      "name": "Alice",
      "email": "alice@example.com",
      "createdAt": "2024-01-01T10:00:00.000Z"
    },
    {
      "_id": "user:456",
      "_rev": "2-def789ghi012",
      "type": "user",
      "name": "Bob",
      "email": "bob@example.com",
      "createdAt": "2024-01-01T09:30:00.000Z",
      "updatedAt": "2024-01-01T10:00:00.000Z"
    },
    {
      "_id": "post:789",
      "_rev": "1-ghi345jkl678",
      "type": "post",
      "title": "Hello World",
      "content": "This is my first post",
      "authorId": "user:123",
      "createdAt": "2024-01-01T10:00:00.000Z"
    }
  ]
}
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | string | 存储格式版本号 |
| `timestamp` | number | 文件创建时间戳（毫秒） |
| `documents` | array | 文档数组 |
| `documents[]._id` | string | 文档唯一标识符 |
| `documents[]._rev` | string | 文档版本号（PouchDB 格式 `{generation}-{hash}`） |
| `documents[]._deleted` | boolean | （可选）文档是否已删除（tombstone） |
| `documents[].*` | any | 其他自定义字段 |

### 合并文件 (merged-*.json)

合并文件格式与数据文件相同，文件名同样用时间戳，不再记录 `startSeq/endSeq`。

```json
{
  "version": "2.0.0",
  "timestamp": 1704099600000,
  "documents": [
    {
      "_id": "user:123",
      "_rev": "3-xyz789abc012",
      "type": "user",
      "name": "Alice Smith",
      "email": "alice@example.com"
    }
  ]
}
```

合并文件通过文件名/路径区分于数据文件（`merged-` 前缀）。同步时 `data/` 与 `merged/` 一并扫描，
同一 `_id` 在多处出现时以 `_rev` generation 最大者为准（见"版本控制"）。

## 文件命名规则

### 数据文件命名

格式：`data-{timestamp}.json`

- `timestamp`: ISO 8601 格式时间戳（去除特殊字符）

示例：
- `data-2024-01-01T10-00-00-000Z.json`
- `data-2024-01-01T10-05-00-000Z.json`

### 合并文件命名

格式：`merged-{timestamp}.json`

- `timestamp`: 合并时间戳

示例：
- `merged-2024-01-01T11-00-00-000Z.json`
- `merged-2024-01-01T12-00-00-000Z.json`

> 注：一次 push 只写一个以本次 timestamp 命名的 data 文件；历史文件靠 `performMerge` 压缩为 merged 文件，避免文件无限膨胀。

## 版本控制

### 文档版本

每个文档使用 PouchDB 原生的 `_rev` 格式：`{generation}-{hash}`，**不使用独立的全局 sequence**。

```json
{
  "_id": "user:123",
  "_rev": "3-abc123def456"
}
```

- `generation`（`3`）表示这是文档的第 3 个版本（数字越大越新）
- `hash`（`abc123def456`）用于冲突/祖先链检测

### 版本比较规则

1. 比较 `_rev` 的 `generation` 部分（数字越大越新）
2. 如果 `generation` 相同但 `hash` 不同 → 视为**冲突**（分叉历史），由 `compareDocumentRevisions` 决定 `use-remote` / `use-local` / `keep-conflict`
3. 同步时始终保留最新版本；`_deleted:true` 的 tombstone 也参与比较（删除即"该 id 的最新版本是已删除"）

### 冲突解决

冲突解决复用引擎既有实现（非 PouchDB 原生 replication，而是手写判断）：

```typescript
// 伪代码（对应 sync-engine 现有 compareDocumentRevisions / resolveIncomingDocument）
const reason = compareDocumentRevisions(localDoc, remoteDoc);
switch (reason) {
  case 'remote-newer':  apply(remoteDoc); break;   // 含 _deleted 删除本地
  case 'local-newer':   /* 不动 */ break;
  case 'conflict':      keepConflict(localDoc, remoteDoc); break; // 生成 sync_conflict:*
}
```

## 无全局序列号

rev2 设计**取消了全局 sequence**：

- 不再维护 `manifest.lastSequence`，文件命名与内容中均无 `sequence` / `startSeq` / `endSeq`。
- "数据写到了第几代"由每个文档自己的 `_rev.generation` 表达，而非由文件级游标表达。
- 增量同步不再依赖序列号区间，而依赖两个本地 `_local` 缓存（详见 `sync-design-rev2.md`）：
  1. `remote-rev-cache`（`_local/sync-remote-rev:${basePath}`）：记录目标文件系统每个 doc 的 `_rev`，用于 push 差异筛选。
  2. `processed-files`（`_local/sync-processed-files:${basePath}`）：记录已处理文件的 `contentHash`，用于 pull 跳过未变文件。

## 文件大小限制

### 默认限制

- 单个数据文件（data-*.json）：最大 2MB（`maxFileSize`，可配置）
- 合并文件（merged-*.json）：最大 2MB（可配置）
- rev2 下**无清单文件**，故此限制仅作用于数据/合并文件本身

### 分片策略（写入即分片 + 单文件体积上限）

`maxFileSize` 作为**单文件体积上限**：一次 push 的差异集若超过 `maxFileSize`，则按体积拆成多个 `data-{timestamp}.json` 写入对应日期子目录；否则只产出一个文件。多个文件之间靠文档自身 `_rev` 决定版本，文件名顺序无关紧要。

```typescript
// 伪代码：按 maxFileSize 拆分差异集，每个 chunk 写入一个 data 文件（写入即分片）
let currentChunk: StoredDocument[] = [];
let currentSize = 0;

for (const doc of documents) {
  const docSize = JSON.stringify(doc).length;

  if (currentSize + docSize > maxFileSize && currentChunk.length > 0) {
    writeDataFile(currentChunk);   // 写入 data/YYYY/MM/DD/data-{timestamp}.json
    currentChunk = [];
    currentSize = 0;
  }

  currentChunk.push(doc);
  currentSize += docSize;
}

if (currentChunk.length > 0) {
  writeDataFile(currentChunk);
}
```

## 文件合并策略

### 合并条件

满足以下所有条件时触发合并（rev2 设计下不再要求序列号连续）：

1. 文件大小小于合并阈值（默认 100KB）
2. 同处 `data/` 目录（或同分区目录）且未被合并过
3. 目录内文件数超过阈值（默认 100）时优先合并较小文件

### 合并过程

```
原始文件:
├── data-2026-01-01T10-00-00-000Z.json (50KB)
├── data-2026-01-01T10-05-00-000Z.json (30KB)
├── data-2026-01-01T10-10-00-000Z.json (40KB)
└── data-2026-01-01T11-00-00-000Z.json (800KB, 太大不合并)

合并后:
├── data-2026-01-01T10-00-00-000Z.json (删除或归档)
├── data-2026-01-01T10-05-00-000Z.json (删除或归档)
├── data-2026-01-01T10-10-00-000Z.json (删除或归档)
├── data-2026-01-01T11-00-00-000Z.json (保留)
└── merged-2026-01-01T12-00-00-000Z.json (新建，含前 3 个文件的全部 doc)
```

> 合并后应从 `processed-files` 缓存移除被合并的源 data 文件条目（合并内容由 merged 文件覆盖，无需保留旧条目）。

### 去重与优先级

读取文档时（无论来自 data/ 还是 merged/）：

1. 同一 `_id` 在多处出现时，以 `_rev` 的 `generation` 最大者为准（不再靠"合并文件优先"的隐式顺序）
2. 合并文件只是把多个小文件的 doc 物理聚合，逻辑上仍按 `_rev` 取最新
3. 读取顺序建议从最新文件（按文件名 timestamp）向旧，先到先得即拿最新版

## 锁文件

### 格式

锁文件名：`.{lockName}.lock`

内容：
```json
{
  "id": "abc123-def456-ghi789",
  "timestamp": 1704096000000,
  "operation": "sync"
}
```

### 锁类型

1. **sync 锁**: `.sync.lock` - 同步操作
2. **merge 锁**: `.merge.lock` - 文件合并操作

### 锁超时

- 默认超时：30 秒
- 超时后自动释放
- 防止死锁

## 合并月份标记文件（跨时区 / 多设备去重）

合并语义为「每月合并上个月」——每次检查只汇总「上一个月及更早」的 data 文件，本月新写入的 data 留到下月。为避免不同时区、不同时钟的电脑重复合并同一段历史，`merged/` 根目录会维护一个基于 **UTC 月份** 的标记：

```
merged/
├── merged-up-to-2026-07.json   # 已合并到 2026-07（内容为 { mergedUpTo, at }）
└── 2026/
    ├── merged-2026-03-12T11-00-00-000Z.json
    └── merged-2026-08-15T11-00-00-000Z.json
```

- 文件名：`{MERGE_UP_TO_PREFIX}{YYYY-MM}.json`，其中 `YYYY-MM` 由 `previousMonthKey()` 计算（即「上一个月」的 UTC 月键，如 2026-08 运行时标记 `merged-up-to-2026-07`）。前缀常量 `MERGE_UP_TO_PREFIX = 'merged-up-to-'`。
- 内容：`{ "mergedUpTo": "2026-07", "at": "<UTC ISO 时间戳>" }`，用于审计「谁、何时合并过哪段」。
- 作用：`performMerge()` 在合并前 `stat` 该文件，若存在（且属于上一个月）则跳过；合并所有「上月及更早」的 data 成功后写入。标记写在**共享存储**上，任何设备/时区检查到即放弃，从而避免重复合并同一段历史。
- 兼容：旧版 `.last-merge-{YYYY-MM}.json` 标记也会被识别为「已合并」（前缀常量 `MERGE_MONTH_LOCK_PREFIX = '.last-merge-'`）。标记文件很小且为固定名，`collectShardFiles` 会额外扫描 `merged/` 根目录一层，不会被漏读，也不会被误当作数据文件参与合并。
- 手动触发合并（`performMerge()`）不受标记约束，便于测试或紧急整理。

## 存储优化

### 1. 增量加载（基于 `_local` 缓存，非 sequence）

```typescript
// push 侧：用 remote-rev-cache 只挑出比目标文件系统更新的 doc
const cache = await db.get(`_local/sync-remote-rev:${safePath}`);
const toPush = localDocs.filter(d =>
  !cache.revs[d._id] || gen(cache.revs[d._id]) < gen(d._rev)
);

// pull 侧：用 processed-files 的 contentHash 跳过未变文件
const processed = await db.get(`_local/sync-processed-files:${safePath}`);
const pending = files.filter(f => processed.files[f] !== hashOf(f));
```

### 2. 按需读取

```typescript
// 不需要立即读取所有文件，按 hash 过滤后只读相关文件
const files = await listAllDataFiles(basePath); // 递归 data/ + merged/
for (const file of files) {
  if (needsFile(file)) {            // needsFile = contentHash 变化 / 未处理
    const docs = await readDataFile(file);
    processDocuments(docs);
  }
}
```

### 3. 并行处理

```typescript
// 并行读取多个文件
const filePromises = files.map(f => readDataFile(f));
const results = await Promise.all(filePromises);
```

## 兼容性

### 向后兼容

- 版本号采用语义化版本控制（`DataFileContent.version`）
- 主版本号变化表示不兼容的更改
- 次版本号变化表示向后兼容的功能添加
- 无 manifest / 无 sequence 是格式层面的简化，旧版含 manifest 的数据文件仍可读取（按文件名直接读 `documents[]` 即可，`_rev` 比较逻辑不变）

### 版本检查

```typescript
// 仅校验数据文件自身的 version 字段
if (content.version !== STORAGE_VERSION) {
  if (needsMigration(content.version)) {
    await migrateContent(content.version, STORAGE_VERSION);
  }
}
```

## 最佳实践

1. **定期合并**: 启用自动合并以保持存储效率
2. **监控文件数**: 避免单个目录文件过多
3. **验证完整性**: 定期检查文件完整性
4. **清理旧文件**: 合并后清理被合并的源 data 文件（并从 `processed-files` 移除条目）
5. **缓存保护**: `remote-rev-cache` / `processed-files` 存于本地 PouchDB `_local` 文档，随 db 一起备份即可，无需单独管理

## 故障恢复

### 本地缓存丢失（非数据丢失）

`remote-rev-cache` 或 `processed-files` 丢失（如内存版 PouchDB 重启）：
- push 退化为"扫目标文件系统重建 `remote-rev-cache` 后全量比对"
- pull 退化为"读全部文件"
两者均**慢但正确**，无需从数据文件重建 manifest。

### 数据文件损坏

- 跳过损坏的文件（JSON 解析失败）
- 从其他文件（如 merged 副本）或 PouchDB 恢复数据
- 记录错误日志

### 锁文件残留

- 检查锁文件时间戳
- 超时的锁自动删除
- 手动清理 `.*.lock` 文件
