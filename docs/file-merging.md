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
└── merged-2024-01-04T13-00-00-000Z.json (65KB, 20 个文档, 5 个文件的合并)
```

读取时按 `_rev` 取最新（合并文件只是物理聚合，不再靠"合并文件优先"的隐式顺序）。

## 合并策略

### 触发条件

合并操作在以下情况触发：

1. **自动合并**: 定时检查（默认每 1 小时检查一次，见 `mergeCheckInterval`）。每次检查只合并**上一个月及更早**的 data 文件；本月新写入的 data 留到下月处理（见下节「跨时区 / 多设备去重」）。
2. **手动合并**: 调用 `performMerge()` 方法
3. **同步完成后**: 如果 `autoMerge` 启用，`sync()` 完成会启动自动合并定时器；每小时醒来一次，扫描是否有「上月及更早」的 data 文件待合并。

> 语义：合并 = 「每月汇总上个月的数据」。即使只有 1 个历史 data 文件也会触发合并（合并后该文件从 `data/` 移走、对应空目录被清理），从而持续压低 `data/` 目录的文件数与层级。本月产生的数据不会被立即合并，要等到下个月的检查才汇总。

### 合并规则

#### 1. 文件大小阈值

```typescript
const DEFAULT_MERGE_THRESHOLD = 100 * 1024; // 100KB
```

只有小于阈值的文件才会被考虑合并。

#### 2. 同目录小文件分组（rev2：不再要求序列号连续）

合并 rev2 设计下去掉了全局序列号，只要同处一个目录（或同分区）且都是小文件，即可成组合并：

```typescript
// ✅ 可以合并（都是小文件，同目录）
files = [
  'data-2024-01-01T10-00-00-000Z.json',
  'data-2024-01-01T10-05-00-000Z.json',
  'data-2024-01-01T10-10-00-000Z.json',
];

// 合并后删除/归档源文件，避免重复扫描
```

#### 3. 排除本月文件 & 已合并文件

- **本月文件排除**：`findMergeCandidates()` 通过文件名中的 `data-YYYY-MM-DD` 解析文件所属 UTC 月，过滤掉与「当前 UTC 月」相同的文件。**本月新写入的数据不参与合并，留到下月处理**——这是「每月合并上个月」语义的核心。
- **已合并文件排除**：合并成功后，源文件被移入 `archive/`（保留原 `data/YYYY/MM/DD` 相对结构），因此后续扫描不会再把它们当作 data 源；同时 `data/` 下被移空的日期分片子目录会被自底向上清理（见下节）。

#### 4. 合并后大小限制（分批）

按累计体积（`maxFileSize`，默认 2MB）分批；单批超过上限即切下一批。下限放宽到 **1 个文件即可成批**（不再要求 ≥2）——这样即便某个月只有 1 个零散 data 文件，也会在次月被合并掉，避免空目录长期残留：

```typescript
const MAX_MERGED_SIZE = options.maxFileSize; // 默认 2 * 1024 * 1024 (2MB)

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
async getMergeCandidates(): Promise<string[][]> {
  // rev2：直接列目录，不再读 manifest
  const files = await this.listAllDataFiles(); // 递归 data/ 下所有 *.json
  const candidates: string[][] = [];
  let currentGroup: string[] = [];
  let groupSize = 0;

  for (const file of files) {
    // 1. 估算文件大小
    const estimatedSize = await this.estimateFileSize(file);

    // 2. 小于阈值则加入当前组
    if (estimatedSize < this.options.mergeThreshold) {
      currentGroup.push(file);
      groupSize += estimatedSize;

      // 3. 组大小达标且文件数 > 1 则成组
      if (groupSize >= this.options.mergeThreshold && currentGroup.length > 1) {
        candidates.push(currentGroup);
        currentGroup = [];
        groupSize = 0;
      }
    } else {
      // 文件太大，不合并
      if (currentGroup.length > 1) {
        candidates.push(currentGroup);
      }
      currentGroup = [];
      groupSize = 0;
    }
  }

  // 4. 保存最后一组
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
  
  // 3. 去重，保留最新版本（按 _rev generation）
  const docMap = new Map<string, StoredDocument>();
  for (const doc of allDocuments) {
    const existing = docMap.get(doc._id);
    if (!existing || this.isNewerVersion(doc._rev, existing._rev)) {
      docMap.set(doc._id, doc);
    }
  }
  
  const mergedDocuments = Array.from(docMap.values());
  
  // 4. 生成合并文件（rev2：文件名用 timestamp，无 sequence / startSeq / endSeq / mergedFrom）
  const timestamp = Date.now();
  const filename = `merged-${formatTimestamp(timestamp)}.json`;
  
  // 5. 写入合并文件
  const content: DataFileContent = {
    version: STORAGE_VERSION,
    timestamp,
    documents: mergedDocuments,
  };
  
  await this.fsUtils.writeJSON(
    this.fsUtils.joinPath(this.mergedDir, filename),
    content
  );
  
  // 6. 删除/归档源文件，并从 processed-files 缓存移除其条目（rev2 无 manifest）
  for (const file of files) {
    await this.deleteOrArchiveFile(file);
    await this.removeProcessedFileEntry(file);
  }
  
  return filename;
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
用户 A (浏览器, UTC+9)     用户 B (Node.js, UTC-8)
     │                        │  （2026-08 运行，合并的是 2026-07 及更早）
     │ 检查 merged/merged-up-to-2026-07  │
     │ stat → 不存在          │ stat → 不存在
     │ 尝试获取 merge 锁      │
     │─────────────────→      │
     │ 获取成功                │
     │ 加锁后再 stat 确认      │ 尝试获取 merge 锁（等待）
     │ 执行合并操作...         │
     │ 写 merged/merged-up-to-2026-07 │
     │ 释放锁                  │
     │                        │ 获取成功
     │                        │ 加锁后 stat → 已存在（上月已合并）
     │                        │ 跳过（不重复合并）
```

#### 跨时区 / 多设备去重（每月合并上个月）

合并语义为「每月汇总上个月及更早的 data 文件」。**本月新写入的 data 不参与合并，留到下月**——这样既天然规避了「本月只写了 1 个文件就触发合并、导致本月后续再也合并不了」的矛盾，也解决了跨时区/多设备重复合并问题。

当同一份存储被多台电脑、或多个时区的浏览器同时使用时，仅靠 `merge` 锁无法阻止设备各自重复合并。为此引入基于 **UTC 月份标记文件** 的协调：

- **标记文件**：合并成功后，在共享存储的 `merged/` 根目录写入 `merged/merged-up-to-{YYYY-MM}.json`（内容为 `{ mergedUpTo, at }`，`at` 为 UTC ISO 时间戳）。`YYYY-MM` = **上一个月**的 UTC 月键（由 `previousMonthKey()` 计算，例如 2026-08 运行时标记 `merged-up-to-2026-07`，表示「2026-07 及更早的数据已汇总」）。全球设备共用同一份「月份」日历。
  - 兼容旧版 `.last-merge-{YYYY-MM}` 标记：`hasMergedThisMonth()` 也会识别旧标记并视为已合并。
- **跳过判断**：`performMerge()` 在抢锁前、以及抢到锁后各做一次 `hasMergedThisMonth()`（即 `stat merged/merged-up-to-{上一个月}`）：
  - 已存在 → 上个月的 data 已有任意设备合并过 → 直接跳过（无论本机时区现在是几月）。
  - 不存在 → 合并所有「上月及更早」的 data 文件，成功后写标记；其他设备检查到标记即放弃，避免重复。
- **为什么用 UTC**：避免「东京已是 8/1、洛杉矶仍是 7/31」导致的同月分歧。统一看 UTC 月，跨时区一致。
- **历史补合并**：若连续多个月没运行（如 7、8 月都没合并，9 月才跑），一次检查会把所有「早于本月」的历史 data 文件一并合并，并把标记写到「上个月」（2026-08），下月再补齐 9 月。
- **竞态窗口**：即使两台设备几乎同时检查到「无标记」，`merge` 锁保证只有一台先执行；另一台抢到锁后「二次确认」发现标记已存在，同样跳过。最坏情况仅出现在 UTC 跨月边界的那几分钟（≤2 次合并），且合并本身幂等（按 `_rev` 去重），仅多生成一个 `merged-*.json`，无害。
- **兼容性**：标记文件写在 `merged/` 根目录（固定名、体积小），`collectShardFiles` 会额外扫描根目录一层 `merged-*.json` / `.last-merge-*` / `merged-up-to-*`，旧文件与标记都不会被漏读。

## 读取优化

### 按 `_rev` 取最新（rev2：不再区分合并/原始文件）

```typescript
async readDataFile(filePath: string): Promise<StoredDocument[]> {
  // rev2：直接按文件路径读取（data/ 或 merged/ 一视同仁）
  const content = await this.fsUtils.readJSON(filePath);
  return content.documents;
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
const file = await fetch('/merged/merged-2024-01-04T13-00-00-000Z.json');
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

### mergeCheckInterval

自动合并的**检查间隔**（毫秒）。默认 `3600_000`（1 小时）。

```typescript
await sync(db, fs, basePath, {
  mergeCheckInterval: 3600 * 1000, // 1 小时检查一次（默认）
});
```

> 语义说明：`mergeCheckInterval` 只控制「多久醒来看看本月要不要合并」，不再控制「多久合并一次」。真正合并频率由 UTC 月份标记（见上节）约束——每台设备每月至多合并一次。把间隔设短（如 5 分钟）只会让检查更勤快，但不会增加合并次数；设太长（如 24 小时）可能导致页面打开当天迟迟不触发检查。

**建议值**:
- 频繁更新 / 多设备: 1 小时（默认，推荐）
- 低频更新 / 单设备: 6~24 小时均可
- 调试时: 可临时设小（如 10 秒）以便快速观察触发，但合并仍受「本月一次」约束（手动 `performMerge()` 不受此约束，便于测试）

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
  // rev2：列目录找到合并后残留的源 data 文件（合并时未删除的）
  const fileList = await this.listAllDataFiles(); // 递归 data/ 下所有 *.json

  for (const filePath of fileList) {
    // 判断该文件是否已被某个 merged 文件覆盖（按内容 _id 集合比对，或维护删除标记）
    if (await this.isMergedSource(filePath)) {
      // 这个文件已经被合并，可以安全删除
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
