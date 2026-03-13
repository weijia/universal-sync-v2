# 存储格式

## 目录结构（以分区目录为主）

存储目录采用分区（partition）目录为主要组织方式，便于横向扩展与人工查找。分区层级可配置（例如按 `year/month[/day]`、按序列桶或任意混合规则），下面给出按年/月/日 的典型示例：

```
storage-root/
├── manifest-index.json        # 轻量全局索引（记录各分区的 lastSequence/lastTimestamp）
├── data/                      # 原始数据分区目录（可按配置分级）
│   ├── 2026/
│   │   ├── 03/
│   │   │   ├── 12/
│   │   │   │   ├── manifest.json  # 分区 manifest
│   │   │   │   ├── data-10234-2026-03-12T10-00-00-000Z.json
│   │   │   │   ├── data-10235-2026-03-12T10-05-00-000Z.json
│   │   │   │   └── ...
│   │   │   └── 11/
│   │   │       └── ...
│   │   └── ...
│   └── ...
└── merged/                    # 合并文件分区目录
  ├── 2026/
  │   ├── 03/
  │   │   ├── 12/
  │   │   │   ├── manifest.json
  │   │   │   ├── merged-10230-10235-2026-03-12T11-00-00-000Z.json
  │   │   │   └── ...
  │   │   └── ...
  │   └── ...
  └── ...
```

说明：

- `manifest-index.json` 是可选的轻量全局索引，用于记录每个分区（例如 `data/2026/03/12`）的最新序列号或时间戳，便于快速定位需要读取或增量同步的分区。  
- 每个分区目录下保留自己的 `manifest.json`，记录该分区内的文件元数据（文件条目、startSeq/endSeq、timestamp、documentCount 等）。
- 分区层级并非强制为日级；可按配置采用 `year/month`、`year/month/day`、按序列桶或其它自定义规则。文档中其余部分描述的 `StorageManager` 与 `ManifestManager` 实现将支持读取相对路径的分区 manifest。
- 迁移与向后兼容：系统支持混合模式（根目录 manifest 与分区 manifest 共存），提供迁移工具将老的根 manifest 条目分发到新的分区 manifest，并生成或更新 `manifest-index.json`。

### 可选：目录分片 — 年/月/日（推荐，便于人工查找）

为了便于人工查找（例如审计、手动恢复或浏览历史），推荐使用按日期分层的目录结构：`data/YYYY/MM/DD/` 与 `merged/YYYY/MM/DD/`。这种方式在目录层次上按时间分区，查找某一天或某段时间的数据非常直观。

示例：

```
storage-root/
├── manifest.json
├── data/
│   ├── 2026/
│   │   ├── 03/
│   │   │   ├── 12/
│   │   │   │   ├── data-10234-2026-03-12T10-00-00-000Z.json
│   │   │   │   ├── data-10235-2026-03-12T10-05-00-000Z.json
│   │   │   │   └── ...
│   │   │   └── 11/
│   │   │       └── ...
│   │   └── ...
│   └── ...
└── merged/
    └── 2026/03/12/merged-10230-10235-2026-03-12T11-00-00-000Z.json
```

设计要点：

- 分片键使用**文件创建时间戳（timestamp）**或文档的最大 timestamp（更准确反映数据时间），按 UTC 年/月/日划分子目录。写入时以文件的 `timestamp` 决定目标年月日路径。
- `manifest.json` 中的 `filename` 字段应包含相对路径，例如 `data/2026/03/12/data-10234-2026-03-12T10-00-00-000Z.json`。
- 读取与写入时需使用 `FileSystemUtils.joinPath(basePath, filename)`，确保支持包含子目录的相对路径。

迁移与兼容：

- 启用新策略时，新的数据文件将写入日期目录，而旧文件仍保留在根 `data/` 或 `merged/` 下，`manifest.json` 会混合包含两种路径格式。
- 读取逻辑无需改变（只要 `filename` 为相对路径并可 `joinPath` 即可）。
- 可提供迁移脚本，将旧文件按文件创建时间或序列号搬移到相应日期目录，并批量更新 `manifest.json`。

优点：

- 人工查找友好：按年/月/日定位文件非常直观。 
- 自然时间分区，便于按时间窗口归档或清理（例如按月归档）。

折衷与注意点：

- 可能导致小目录（每天的目录）中文件较少，但这符合按时间切分的设计初衷；如果某一天写入量极大，可结合每日内次级分片（例如小时或按计数）扩展。 
- 需要确保 `FileSystem` 后端对频繁创建子目录的性能可接受（在 WebDAV 或对象存储上需验证）。

实现步骤（建议）：

1. 在 `StorageManager.writeDocuments()` 中使用写入文件的 `timestamp`（或 documents 中最大的 timestamp）计算目标目录 `data/YYYY/MM/DD` 或 `merged/YYYY/MM/DD`，并 `fs.mkdir(..., { recursive: true })` 确保目录存在。  
2. 生成文件名（保持原有命名 `data-{sequence}-{timestamp}.json`），但将其放入子目录并在写入 `manifest.json` 时使用相对路径。  
3. 确保 `FileSystemUtils.readJSON` / `fsUtils.joinPath` 能正确处理带子目录的 `filename`。  
4. 更新并新增测试，验证写入路径、读取、合并与迁移场景。
5. （可选）实现迁移脚本将旧根目录文件搬移到按日期分片的目录并修正 `manifest.json`。

如果你确认按年/月/日的方案，我会按上面步骤修改 `StorageManager` 并添加测试；如果你希望混合策略（例如每日日志外再按计数分片），也可以在这里讨论并确定具体规则。

## 自适应分片（按需迁移到月/日）

描述：

除了默认按年/月/日写入外，也可以采用“懒迁移 / 自适应”策略 —— 不强制把每个文件立即写入日目录；而是在根目录或当前目录保持简单写入，在检测到单一目录中文件数超过配置阈值（`maxFilesPerDirectory`）时，把部分文件迁移到按月或按日的子目录。这种方式兼顾写入性能与人工可查性。

触发时机（可选，多种触发点）：

- 写入后检测：每次写入新 data 文件后检查所在目录的文件数，若超过阈值，触发迁移。此方式及时但会在写入路径增加延迟。  
- 后台任务：周期性后台整理（推荐），例如每分钟或每小时检查一次并迁移超限目录，避免影响写入路径延迟。  
- 手动触发：运维触发或 CLI 命令执行迁移（适合大型迁移）。

迁移策略：

1. 选择迁移候选：在超限目录中按文件的 timestamp 或序列号排序，优先迁移**较旧**的文件到目标 `data/YYYY/MM[/DD]/` 路径。  
2. 目标层级选择：当超限不严重时先迁移到 `data/YYYY/MM/`；若该月目录也超限或需要更精细分区，再迁移到 `data/YYYY/MM/DD/`。  
3. 原子操作：对每个被迁移的文件，执行步骤：
  - 获取 `merge`/`sync` 相关锁（使用现有 `LockManager` 的合适锁名，例如 `reorg`），防止并发读写冲突。  
  - 在文件系统层执行 `fs.rename(oldPath, newPath)`（若后端不支持原子重命名，可改为 copy + verify + unlink）。  
  - 更新 `manifest.json` 中对应文件的 `filename` 字段为新的相对路径；此更新应在同一锁下以保证一致性（建议使用 `ManifestManager.updateFile()` 原子写入）。  
  - 释放锁。

并发与一致性注意事项：

- 使用 `LockManager` 的分布式锁来保护迁移与并发同步/合并操作，避免读取到短暂的路径不一致。  
- 在迁移过程中，如果有并发的读取请求仍会按 manifest 中的旧路径失败（或需要在读取失败时回退检查老路径），因此迁移应尽可能在持有锁并同时更新清单后完成重命名。  
- 对于非原子存储（某些 WebDAV 实现），迁移应采用 copy+fsync+manifest-update+unlink 的顺序，并在失败时进行回滚或重试策略。

清单与回滚：

- 在更新 `manifest.json` 之前，确保新文件已写入/移动成功。若更新清单失败，应回滚（将文件移动回原处或标记失败并记录日志）。  
- 可在 `manifest` 中新增 `migrated` 或 `migratedAt` 字段以记录迁移历史，便于审计与回滚。

配置参数建议：

- `maxFilesPerDirectory`（已有配置）用于判断何时触发迁移。  
- `reorgBatchSize`：每次迁移批次大小，避免一次性移动太多文件（默认 100）。
- `reorgMode`：`auto|background|manual`，控制是否自动触发和触发方式。

实现步骤（建议优先级）：

1. 在 `StorageManager` 中添加 `reorg` / `ensureDirLimit` 方法：用于检测目录文件数并返回需要迁移的文件列表（按 timestamp/seq）。  
2. 新增 `StorageManager.reorganize()`，实现迁移逻辑（重命名 + `ManifestManager.updateFile()`），使用 `LockManager` 保护。  
3. 在写入流程末尾或作为独立后台定时任务调用 `reorganize()`（依据 `reorgMode`）。  
4. 添加配置项 `reorgBatchSize` 与 `reorgMode` 到 `SyncOptions` 与 `DEFAULT_CONFIG`。  
5. 添加/更新单元测试：模拟文件系统（`MemoryFileSystem`）验证迁移后 `manifest` 更新、并发锁保护与失败回滚分支。  
6. 集成手动 CLI（可选）：`node tools/reorg.js --path ./storage --dry-run` 以便运维手动触发和验证。

是否按上述自适应迁移方案实现（我会优先实现后台模式并添加测试）？如同意，我会开始修改 `StorageManager` 并新增测试用例。 

## 分区 Manifest（Partitioned manifest）

描述：

为了解决单一 `manifest.json` 在大规模场景下的瓶颈问题，可以将 manifest 分区保存到与数据文件相同或相近的目录层级中（即“分区 manifest”）。每个数据分区维护自己的小型 manifest，系统还保留一个轻量的全局索引（或称分区目录 manifest）用于记录每个分区的最新序列号与时间戳，便于快速定位需要读取的分区。

关键点：

- **分区对应**：每个数据分区（例如 `data/2026/03/`、`data/2026/03/12/` 或任意其它分片规则）包含一个 `manifest.json`，用于记录该分区下的文件条目与元数据。全局索引记录每个分区的 `lastSequence` / `lastTimestamp`。  
- **灵活分片层级**：数据目录的分片层级**不是强制固定为日级**。可以按月、按日、按小时、按计数或混合策略设置分区粒度。文档与实现需支持：
  - 配置分片层级（例如 `partitionScheme: 'year/month' | 'year/month/day' | 'month' | 'sequence-bucket'`）；
  - 在运行时根据配置解析并读写对应分区的 manifest 与数据文件。
- **写入与并发**：写入数据文件时只更新对应分区的 manifest（局部 atomicWrite），可大幅降低写锁争用。全局索引的更新频率较低，仅需在分区创建或全局统计变更时更新。  
- **读取与合并**：读取/合并操作按需加载少量分区 manifest 而非全量加载单个大型 manifest，降低 IO 与延迟。合并候选计算可以只在相关时间窗口或分区内执行。
- **兼容性与迁移**：当系统启用分区 manifest 时，旧的单一 `manifest.json` 可以作为迁移源：提供迁移工具将条目分发到各个分区的 manifest，并生成全局索引（轻量的 `manifest-index.json`）。系统也应支持混合模式：同时识别根目录 manifest 与分区 manifest 以便平滑切换。

实现建议（概要）：

1. 扩展 `ManifestManager`：支持按相对 `partitionKey` 读取/写入分区 manifest，并提供按时间/序列范围汇总 API（如 `getFilesInRange(startSeq, endSeq)`）。
2. 新增 `GlobalIndex`（轻量 JSON）记录每个分区的路径与 `lastSequence`/`lastTimestamp`，减少广播式扫描。  
3. `StorageManager.writeDocuments()` 在写入数据文件后只更新对应分区 manifest；若分区不存在则创建并在 `GlobalIndex` 注册。  
4. 迁移工具：当从单一 manifest 切换到分区 manifest 时，按分区规则重写 manifest 条目并生成 `GlobalIndex`。  
5. 测试覆盖：验证分区写入、分区读取聚合、并发更新与迁移流程。 

这个方案与前面的目录分片/自适应迁移设计配合良好：目录分片控制文件分布，分区 manifest 控制元数据规模，实现可扩展且对运维友好的存储布局。

## 文件格式

### 清单文件 (manifest.json)

清单文件记录了所有数据文件的元数据，是同步系统的索引。

```json
{
  "version": "2.0.0",
  "lastSequence": 42,
  "lastTimestamp": 1704110400000,
  "files": [
    {
      "filename": "data-1-2024-01-01T10-00-00-000Z.json",
      "startSeq": 1,
      "endSeq": 1,
      "timestamp": 1704096000000,
      "documentCount": 15
    },
    {
      "filename": "data-2-2024-01-01T10-05-00-000Z.json",
      "startSeq": 2,
      "endSeq": 2,
      "timestamp": 1704096300000,
      "documentCount": 20
    },
    {
      "filename": "merged-1-3-2024-01-01T11-00-00-000Z.json",
      "startSeq": 1,
      "endSeq": 3,
      "timestamp": 1704099600000,
      "documentCount": 50,
      "mergedFrom": [
        "data-1-2024-01-01T10-00-00-000Z.json",
        "data-2-2024-01-01T10-05-00-000Z.json",
        "data-3-2024-01-01T10-10-00-000Z.json"
      ]
    }
  ]
}
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | string | 存储格式版本号 |
| `lastSequence` | number | 最后的全局序列号 |
| `lastTimestamp` | number | 最后更新的时间戳（毫秒） |
| `files` | array | 数据文件元数据数组 |
| `files[].filename` | string | 文件名 |
| `files[].startSeq` | number | 文件包含的起始序列号 |
| `files[].endSeq` | number | 文件包含的结束序列号 |
| `files[].timestamp` | number | 文件创建时间戳 |
| `files[].documentCount` | number | 文件中的文档数量 |
| `files[].mergedFrom` | string[] | （可选）如果是合并文件，记录源文件名 |

### 数据文件 (data-*.json)

数据文件包含实际的文档数据。

```json
{
  "version": "2.0.0",
  "timestamp": 1704096000000,
  "sequence": 1,
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
| `sequence` | number | 文件的序列号 |
| `documents` | array | 文档数组 |
| `documents[]._id` | string | 文档唯一标识符 |
| `documents[]._rev` | string | 文档版本号（PouchDB 格式） |
| `documents[]._deleted` | boolean | （可选）文档是否已删除 |
| `documents[].*` | any | 其他自定义字段 |

### 合并文件 (merged-*.json)

合并文件格式与数据文件基本相同，但包含额外的元数据。

```json
{
  "version": "2.0.0",
  "timestamp": 1704099600000,
  "sequence": 1,
  "documents": [
    {
      "_id": "user:123",
      "_rev": "3-xyz789abc012",
      "type": "user",
      "name": "Alice Smith",
      "email": "alice@example.com"
    }
  ],
  "metadata": {
    "filename": "merged-1-3-2024-01-01T11-00-00-000Z.json",
    "startSeq": 1,
    "endSeq": 3,
    "timestamp": 1704099600000,
    "documentCount": 50,
    "mergedFrom": [
      "data-1-2024-01-01T10-00-00-000Z.json",
      "data-2-2024-01-01T10-05-00-000Z.json",
      "data-3-2024-01-01T10-10-00-000Z.json"
    ]
  }
}
```

**额外字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `metadata` | object | 合并文件的元数据 |
| `metadata.mergedFrom` | string[] | 源文件列表 |

## 文件命名规则

### 数据文件命名

格式：`data-{sequence}-{timestamp}.json`

- `sequence`: 全局递增序列号
- `timestamp`: ISO 8601 格式时间戳（去除特殊字符）

示例：
- `data-1-2024-01-01T10-00-00-000Z.json`
- `data-2-2024-01-01T10-05-00-000Z.json`

### 合并文件命名

格式：`merged-{startSeq}-{endSeq}-{timestamp}.json`

- `startSeq`: 起始序列号
- `endSeq`: 结束序列号
- `timestamp`: 合并时间戳

示例：
- `merged-1-5-2024-01-01T11-00-00-000Z.json`
- `merged-10-25-2024-01-01T12-00-00-000Z.json`

## 版本控制

### 文档版本

每个文档使用 PouchDB 的版本号格式：`{sequence}-{hash}`

```json
{
  "_id": "user:123",
  "_rev": "3-abc123def456"
}
```

- 序列号 `3` 表示这是文档的第 3 个版本
- 哈希值 `abc123def456` 用于冲突检测

### 版本比较规则

1. 比较版本号的序列号部分（数字越大越新）
2. 如果序列号相同，比较哈希值（字典序）
3. 同步时始终保留最新版本

### 冲突解决

```typescript
// 伪代码
if (fileDoc.sequence > pouchDoc.sequence) {
  // 文件中的版本更新
  updatePouchDB(fileDoc);
} else if (fileDoc.sequence < pouchDoc.sequence) {
  // PouchDB 中的版本更新
  writeToFile(pouchDoc);
} else {
  // 序列号相同，比较哈希
  if (fileDoc.hash > pouchDoc.hash) {
    updatePouchDB(fileDoc);
  }
}
```

## 序列号分配

### 全局序列号

- 从 1 开始递增
- 每次写入新的数据文件时递增
- 记录在 `manifest.json` 的 `lastSequence` 字段

### 序列号作用

1. **排序**: 确定文件的时间顺序
2. **增量同步**: 只读取新增的文件
3. **合并标识**: 识别连续的文件组

## 文件大小限制

### 默认限制

- 单个数据文件：最大 1MB
- 合并文件：最大 1MB（可配置）
- 清单文件：无限制（但应保持合理大小）

### 分片策略

当文档批次超过文件大小限制时：

```typescript
// 伪代码
let currentChunk = [];
let currentSize = 0;

for (const doc of documents) {
  const docSize = JSON.stringify(doc).length;
  
  if (currentSize + docSize > maxFileSize && currentChunk.length > 0) {
    // 写入当前分片
    writeDataFile(currentChunk);
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

满足以下所有条件时触发合并：

1. 文件大小小于合并阈值（默认 100KB）
2. 文件序列号连续
3. 文件未被标记为已合并

### 合并过程

```
原始文件:
├── data-1.json (50KB, seq 1)
├── data-2.json (30KB, seq 2)
├── data-3.json (40KB, seq 3)
└── data-4.json (800KB, seq 4)

合并后:
├── data-1.json (保留，但清单中标记为 archived)
├── data-2.json (保留，但清单中标记为 archived)
├── data-3.json (保留，但清单中标记为 archived)
├── data-4.json (保留，太大无需合并)
└── merged-1-3.json (新建，120KB，包含 seq 1-3)
```

### 合并优先级

读取文档时的优先级：

1. **合并文件优先**: 如果存在合并文件，优先读取
2. **原始文件备份**: 原始文件保留作为备份
3. **去重处理**: 同一文档 ID 只保留最新版本

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

## 存储优化

### 1. 增量加载

```typescript
// 只加载新文件
const lastSeq = await getLastProcessedSequence();
const newFiles = files.filter(f => f.startSeq > lastSeq);
```

### 2. 按需读取

```typescript
// 不需要立即读取所有文件
const files = await manifest.getFiles();
for (const file of files) {
  if (needsFile(file)) {
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

- 版本号采用语义化版本控制
- 主版本号变化表示不兼容的更改
- 次版本号变化表示向后兼容的功能添加

### 版本检查

```typescript
if (manifest.version !== STORAGE_VERSION) {
  if (needsMigration(manifest.version)) {
    await migrateStorage(manifest.version, STORAGE_VERSION);
  }
}
```

## 最佳实践

1. **定期合并**: 启用自动合并以保持存储效率
2. **监控文件数**: 避免单个目录文件过多
3. **备份清单**: 定期备份 `manifest.json`
4. **验证完整性**: 定期检查文件完整性
5. **清理旧文件**: 根据需要清理已归档的原始文件

## 故障恢复

### 清单文件损坏

```typescript
// 从数据文件重建清单
const dataFiles = await fs.readdir(dataDir);
const manifest = {
  version: STORAGE_VERSION,
  lastSequence: 0,
  lastTimestamp: Date.now(),
  files: [],
};

for (const filename of dataFiles) {
  const content = await readJSON(filename);
  manifest.files.push({
    filename,
    startSeq: content.sequence,
    endSeq: content.sequence,
    timestamp: content.timestamp,
    documentCount: content.documents.length,
  });
}

await writeManifest(manifest);
```

### 数据文件损坏

- 跳过损坏的文件
- 从其他文件或 PouchDB 恢复数据
- 记录错误日志

### 锁文件残留

- 检查锁文件时间戳
- 超时的锁自动删除
- 手动清理 `.*.lock` 文件
