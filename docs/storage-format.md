# 存储格式

## 目录结构

```
storage-root/
├── manifest.json              # 清单文件（元数据索引）
├── data/                      # 原始数据文件目录
│   ├── data-1-2024-01-01T10-00-00-000Z.json
│   ├── data-2-2024-01-01T10-05-00-000Z.json
│   ├── data-3-2024-01-01T10-10-00-000Z.json
│   └── ...
└── merged/                    # 合并文件目录
    ├── merged-1-3-2024-01-01T11-00-00-000Z.json
    ├── merged-4-8-2024-01-01T12-00-00-000Z.json
    └── ...
```

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
