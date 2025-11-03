# 文件合并机制

## 概述

文件合并是 Universal Sync V2 的核心优化功能之一。通过自动合并小文件，系统可以：

- 减少文件数量，提高文件系统性能
- 减少 HTTP 请求数量（在 WebDAV 等场景）
- 优化存储空间利用
- 提高读取性能

## 为什么需要文件合并

### 问题场景

在频繁更新的场景下，系统会产生大量小文件：

```
data/
├── data-1.json (10KB, 3 个文档)
├── data-2.json (15KB, 5 个文档)
├── data-3.json (8KB, 2 个文档)
├── data-4.json (12KB, 4 个文档)
├── data-5.json (20KB, 6 个文档)
└── ... (数百个小文件)
```

### 带来的问题

1. **文件系统开销**: 每个文件都有元数据开销
2. **网络请求**: WebDAV 场景下需要多次 HTTP 请求
3. **索引负担**: 清单文件变得臃肿
4. **读取效率**: 需要打开多个文件来读取数据

### 合并后的效果

```
data/
├── data-1.json (10KB, 原始文件保留)
├── data-2.json (15KB, 原始文件保留)
├── data-3.json (8KB, 原始文件保留)
├── data-4.json (12KB, 原始文件保留)
├── data-5.json (20KB, 原始文件保留)
└── ...

merged/
└── merged-1-5.json (65KB, 20 个文档, 5 个文件的合并)
```

读取时优先使用合并文件，一次请求获取所有数据。

## 合并策略

### 触发条件

合并操作在以下情况触发：

1. **自动合并**: 定期扫描（默认 60 秒）
2. **手动合并**: 调用 `performMerge()` 方法
3. **同步完成后**: 如果 `autoMerge` 启用

### 合并规则

#### 1. 文件大小阈值

```typescript
const DEFAULT_MERGE_THRESHOLD = 100 * 1024; // 100KB
```

只有小于阈值的文件才会被考虑合并。

#### 2. 序列号连续性

只合并序列号连续的文件：

```typescript
// ✅ 可以合并（序列号连续：1, 2, 3）
files = [
  { startSeq: 1, endSeq: 1 },
  { startSeq: 2, endSeq: 2 },
  { startSeq: 3, endSeq: 3 },
];

// ❌ 不能合并（序列号不连续：1, 3, 4）
files = [
  { startSeq: 1, endSeq: 1 },
  { startSeq: 3, endSeq: 3 },
  { startSeq: 4, endSeq: 4 },
];
```

#### 3. 排除已合并文件

已经被合并过的文件不再参与合并：

```typescript
// 检查是否已合并
if (file.mergedFrom) {
  // 跳过此文件
  continue;
}
```

#### 4. 合并后大小限制

合并后的文件不应超过最大文件大小：

```typescript
const MAX_MERGED_SIZE = 1024 * 1024; // 1MB

let totalSize = 0;
for (const file of candidateGroup) {
  totalSize += estimateFileSize(file);
  
  if (totalSize > MAX_MERGED_SIZE) {
    // 停止添加到此组
    break;
  }
}
```

## 合并算法

### 识别合并候选

```typescript
async getMergeCandidates(): Promise<DataFileMetadata[][]> {
  const manifest = await this.readManifest();
  const candidates: DataFileMetadata[][] = [];
  let currentGroup: DataFileMetadata[] = [];
  let groupSize = 0;
  
  for (const file of manifest.files) {
    // 1. 跳过已合并的文件
    if (file.mergedFrom) {
      if (currentGroup.length > 1) {
        candidates.push(currentGroup);
      }
      currentGroup = [];
      groupSize = 0;
      continue;
    }
    
    // 2. 估算文件大小
    const estimatedSize = file.documentCount * 1000;
    
    // 3. 检查是否小于阈值
    if (estimatedSize < this.options.mergeThreshold) {
      currentGroup.push(file);
      groupSize += estimatedSize;
      
      // 4. 检查组大小
      if (groupSize >= this.options.mergeThreshold && currentGroup.length > 1) {
        candidates.push(currentGroup);
        currentGroup = [];
        groupSize = 0;
      }
    } else {
      // 文件太大，不需要合并
      if (currentGroup.length > 1) {
        candidates.push(currentGroup);
      }
      currentGroup = [];
      groupSize = 0;
    }
  }
  
  // 5. 保存最后一组
  if (currentGroup.length > 1) {
    candidates.push(currentGroup);
  }
  
  return candidates;
}
```

### 合并执行

```typescript
async mergeFiles(files: DataFileMetadata[]): Promise<DataFileMetadata> {
  // 1. 验证
  if (files.length < 2) {
    throw new Error('Need at least 2 files to merge');
  }
  
  // 2. 读取所有文件的文档
  const allDocuments: StoredDocument[] = [];
  for (const file of files) {
    const docs = await this.readDataFile(file);
    allDocuments.push(...docs);
  }
  
  // 3. 去重，保留最新版本
  const docMap = new Map<string, StoredDocument>();
  for (const doc of allDocuments) {
    const existing = docMap.get(doc._id);
    if (!existing || this.isNewerVersion(doc._rev, existing._rev)) {
      docMap.set(doc._id, doc);
    }
  }
  
  const mergedDocuments = Array.from(docMap.values());
  
  // 4. 生成合并文件
  const startSeq = files[0].startSeq;
  const endSeq = files[files.length - 1].endSeq;
  const timestamp = Date.now();
  const filename = `merged-${startSeq}-${endSeq}-${formatTimestamp(timestamp)}.json`;
  
  // 5. 写入合并文件
  const content: DataFileContent = {
    version: STORAGE_VERSION,
    timestamp,
    sequence: startSeq,
    documents: mergedDocuments,
    metadata: {
      filename,
      startSeq,
      endSeq,
      timestamp,
      documentCount: mergedDocuments.length,
      mergedFrom: files.map(f => f.filename),
    },
  };
  
  await this.fsUtils.writeJSON(
    this.fsUtils.joinPath(this.mergedDir, filename),
    content
  );
  
  // 6. 更新清单
  const mergedMetadata: DataFileMetadata = {
    filename,
    startSeq,
    endSeq,
    timestamp,
    documentCount: mergedDocuments.length,
    mergedFrom: files.map(f => f.filename),
  };
  
  // 标记原始文件为已归档
  for (const file of files) {
    await this.manifestManager.updateFile(file.filename, {
      mergedFrom: ['archived'],
    });
  }
  
  // 添加合并文件元数据
  await this.manifestManager.addFile(mergedMetadata);
  
  return mergedMetadata;
}
```

## 并发控制

### 防止并发合并

使用锁机制确保同一时间只有一个进程执行合并：

```typescript
async performMerge(): Promise<void> {
  if (this.mergeInProgress) {
    console.log('Merge already in progress, skipping...');
    return;
  }
  
  this.mergeInProgress = true;
  
  try {
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
```

### 锁的作用

1. **互斥访问**: 同一时间只有一个进程可以合并
2. **读取保护**: 合并期间不影响读取操作
3. **超时保护**: 防止进程崩溃导致死锁

### 多用户场景

```
用户 A (浏览器)          用户 B (Node.js)
     │                        │
     │ 尝试获取 merge 锁      │
     │─────────────────→      │
     │ 获取成功                │
     │                        │ 尝试获取 merge 锁
     │                        │←─────────────
     │ 执行合并操作...         │ 等待...
     │                        │
     │ 释放锁                  │
     │                        │ 获取成功
     │                        │ 执行合并操作...
```

## 读取优化

### 优先使用合并文件

```typescript
async readDataFile(metadata: DataFileMetadata): Promise<StoredDocument[]> {
  let filePath: string;
  
  // 优先使用合并文件
  if (metadata.mergedFrom) {
    filePath = this.fsUtils.joinPath(this.mergedDir, metadata.filename);
  } else {
    filePath = this.fsUtils.joinPath(this.dataDir, metadata.filename);
  }
  
  try {
    const content = await this.fsUtils.readJSON<DataFileContent>(filePath);
    return content.documents;
  } catch (error) {
    console.error(`Failed to read file ${metadata.filename}:`, error);
    return [];
  }
}
```

### 减少请求数量

**合并前**:
```typescript
// 需要 5 次请求
for (let i = 1; i <= 5; i++) {
  const file = await fetch(`/data/data-${i}.json`);
  const data = await file.json();
  processDocuments(data.documents);
}
```

**合并后**:
```typescript
// 只需 1 次请求
const file = await fetch('/merged/merged-1-5.json');
const data = await file.json();
processDocuments(data.documents);
```

## 性能影响

### 合并成本

1. **CPU**: 读取和去重文档
2. **内存**: 加载多个文件到内存
3. **磁盘 I/O**: 读取源文件，写入合并文件
4. **网络**: WebDAV 场景下的文件传输

### 优化建议

1. **批量合并**: 一次性处理多个候选组
2. **异步执行**: 不阻塞主同步流程
3. **增量合并**: 只合并新文件
4. **限制频率**: 避免过于频繁的合并

### 性能对比

| 场景 | 合并前 | 合并后 | 提升 |
|------|--------|--------|------|
| 文件数量 | 1000 | 100 | 90% ↓ |
| HTTP 请求 | 1000 | 100 | 90% ↓ |
| 总下载量 | 50MB | 48MB | 4% ↓ |
| 读取时间 | 10s | 2s | 80% ↓ |

## 配置选项

### mergeThreshold

文件大小阈值，小于此值的文件才会被合并。

```typescript
await sync(db, fs, basePath, {
  mergeThreshold: 100 * 1024, // 100KB
});
```

**建议值**:
- 低带宽: 50KB
- 中等带宽: 100KB
- 高带宽: 200KB

### mergeInterval

自动合并的检查间隔。

```typescript
await sync(db, fs, basePath, {
  mergeInterval: 60000, // 60秒
});
```

**建议值**:
- 频繁更新: 30 秒
- 正常使用: 60 秒
- 低频更新: 300 秒

### autoMerge

是否启用自动合并。

```typescript
await sync(db, fs, basePath, {
  autoMerge: true,
});
```

**建议**:
- 生产环境: `true`
- 开发环境: `false`（手动控制）
- 测试环境: `false`

## 手动合并

### 触发合并

```typescript
import { SyncEngine } from 'universal-sync-v2';

const engine = new SyncEngine(db, fs, options);
await engine.initialize();

// 执行一次合并
await engine.performMerge();

// 或在同步后自动合并
await engine.sync(); // 如果 autoMerge=true，会自动合并
```

### 监控合并

```typescript
let mergeCount = 0;

const originalMerge = engine.performMerge.bind(engine);
engine.performMerge = async function() {
  console.log('Starting merge...');
  const start = Date.now();
  
  await originalMerge();
  
  mergeCount++;
  const duration = Date.now() - start;
  console.log(`Merge ${mergeCount} completed in ${duration}ms`);
};
```

## 故障处理

### 合并失败

如果合并过程中发生错误：

1. **原始文件保留**: 不会删除源文件
2. **清单回滚**: 清单不会更新
3. **可重试**: 下次合并会重新尝试

### 部分合并

如果某些文件合并失败：

```typescript
for (const group of candidates) {
  try {
    await this.storageManager.mergeFiles(group);
    console.log(`✓ Merged ${group.length} files`);
  } catch (error) {
    console.error(`✗ Failed to merge group:`, error);
    // 继续处理下一组
  }
}
```

### 清理残留

手动清理已归档的原始文件：

```typescript
async cleanupArchivedFiles(): Promise<void> {
  const manifest = await this.manifestManager.readManifest();
  
  for (const file of manifest.files) {
    if (file.mergedFrom && file.mergedFrom[0] === 'archived') {
      // 这个文件已经被合并，可以安全删除
      const filePath = this.fsUtils.joinPath(this.dataDir, file.filename);
      try {
        await this.fs.unlink(filePath);
        console.log(`Cleaned up ${file.filename}`);
      } catch (error) {
        // 文件可能已经不存在
      }
    }
  }
}
```

## 最佳实践

1. **启用自动合并**: 在生产环境中保持启用
2. **合理设置阈值**: 根据网络条件和更新频率调整
3. **监控合并状态**: 定期检查合并效果
4. **定期清理**: 清理已归档的原始文件
5. **测试恢复**: 定期测试从合并文件恢复数据
6. **保留原文件**: 至少保留一段时间作为备份
