# 架构设计

## 概述

Universal Sync V2 是一个通用的 PouchDB 同步库，它将 PouchDB 数据库与基于 JSON 文件的存储系统进行同步。该库的设计目标是：

- 跨平台支持（Node.js 和浏览器）
- 自动版本控制和冲突解决
- 高性能的文件分片和合并
- 多用户并发访问支持
- 简单易用的单一接口

## 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                     User Application                     │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                    sync(db, fs, path)                    │
│                   (Main Entry Point)                     │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                     SyncEngine                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  • 协调 PouchDB 与文件存储的同步                  │  │
│  │  • 管理同步生命周期                               │  │
│  │  • 自动触发文件合并                               │  │
│  └──────────────────────────────────────────────────┘  │
└────────┬──────────────────────┬────────────────┬────────┘
         │                      │                │
         ▼                      ▼                ▼
┌─────────────────┐  ┌──────────────────┐  ┌─────────────┐
│ StorageManager  │  │  LockManager     │  │  LocalCache  │
│                 │  │                  │  │ (PouchDB    │
│ • 数据文件读写  │  │ • 分布式锁实现   │  │  _local 文档)│
│ • 文件分片      │  │ • 并发控制       │  │             │
│ • 文件合并      │  │ • 防止竞争条件   │  │ • remote-rev │
└─────────────────┘  └──────────────────┘  │ • processed- │
                                           │   files     │
                                           │ • lastSeq   │
                                           └─────────────┘
         │                      │                │
         └──────────────────────┴────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                  File System Layer                       │
│  ┌──────────────────────────────────────────────────┐  │
│  │  IFileSystem Interface                            │  │
│  │  • Node.js: fs/promises                          │  │
│  │  • Browser: zen-fs, BrowserFS, etc.              │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Actual Storage (Files/WebDAV)              │
└─────────────────────────────────────────────────────────┘
```

## 核心模块

### 1. SyncEngine（同步引擎）

**职责：**
- 协调 PouchDB 和文件存储之间的双向同步
- 从最新数据开始同步，确保 PouchDB 始终包含最新内容
- 管理自动文件合并的生命周期

**关键方法：**
- `initialize()`: 初始化存储结构
- `sync()`: 执行完整同步
- `performMerge()`: 执行文件合并

### 2. StorageManager（存储管理器）

**职责：**
- 管理数据文件的读写
- 实现智能分片，确保单个文件不会太大
- 执行文件合并操作
- 优先读取合并后的文件以提高性能

**关键方法：**
- `writeDocuments()`: 写入已筛选的差异文档集
- `readAllDocuments()`: 列目录 + 按 `processed-files` 过滤 + 读 + 按 `_rev` 去重
- `listAllDataFiles()`: 递归列出 `data/` + `merged/` 下所有 `*.json`
- `mergeFiles()`: 合并多个数据文件

### 3. LocalCache（本地缓存，基于 PouchDB `_local` 文档）

> rev2 设计下，`ManifestManager` 已被移除，其元数据职责改由本地 `_local` 文档承担。

**职责：**
- `remote-rev-cache`（`_local/sync-remote-rev:${basePath}`）：记录目标文件系统每个 doc 的 `_rev`，用于 push 差异筛选
- `processed-files`（`_local/sync-processed-files:${basePath}`）：记录已处理文件的 `contentHash`，用于 pull 跳过未变文件
- `lastPushedSeq`（`_local/sync-seq:${basePath}`）：记录 `db.info().update_seq`，用于 push 轻量跳过
- 上述缓存仅存于本地 PouchDB，**不写入目标文件系统、不参与 replication**

**关键方法（由 SyncEngine 实现）：**
- `getLocalDoc(key)` / `setLocalDoc(key, value)`: 读写 `_local` 文档
- `buildRemoteRevCacheFromFiles()`: cache 为空时扫目标文件系统重建

### 4. LockManager（锁管理器）

**职责：**
- 实现基于文件系统的分布式锁
- 防止多个进程同时修改同一资源
- 自动清理过期的锁
- 提供锁超时和重试机制

**关键方法：**
- `acquireLock()`: 获取锁
- `releaseLock()`: 释放锁
- `withLock()`: 在锁保护下执行操作

## 数据流

### 同步流程

完整的同步流程包含以下阶段，详见 [同步过程详解](./sync-process.md)：

```
1. 初始化
   ├─ 创建目录结构
   └─（rev2）不再读取/创建清单文件

2. Pull 阶段（从文件加载到 PouchDB）
   ├─ 列目录 data/ + merged/ 发现文件
   ├─ 用 processed-files 的 contentHash 跳过未变文件
   ├─ 读取待处理文件（支持分区目录）
   ├─ 版本比较（基于 _rev 字段，compareDocumentRevisions）
   ├─ 批量更新到 PouchDB (bulkDocs)
   └─ 回写 remote-rev-cache

3. Push 阶段（从 PouchDB 保存到文件，基于 _rev 差异）
   ├─ update_seq 轻量跳过（无变更直接返回）
   ├─ 初始化 remote-rev-cache（为空则扫文件系统重建）
   ├─ 读取 PouchDB 所有文档（含 tombstone, allDocs({include_docs})）
   ├─ 按 _rev 差异筛选需推送文档
   ├─ 二次 compareDocumentRevisions 兜底
   ├─ 写入差异集到 data-{timestamp}.json（原子写入）
   └─ 回写 remote-rev-cache + update_seq 游标

4. 自动文件合并（可选）
   ├─ 定期扫描同目录小文件（不再要求序列号连续）
   ├─ 执行合并操作（按 _rev 去重）
   └─ 删除/归档源 data 文件 + 清理 processed-files 条目
```

### 详细同步过程

更多实现细节请参考 [同步过程详解](./sync-process.md) 与 [同步设计 V2](./sync-design-rev2.md) 文档，包括：
- 完整的代码流程和关键函数
- 版本控制机制（`_rev` 字段解析，无全局 sequence）
- 分区存储策略（年/月目录结构）
- 并发控制实现（分布式锁）
- 增量同步算法（基于 `_local` 缓存，详见 sync-design-rev2.md）

### 并发控制

```
锁机制：
┌─────────────────────────────────────────┐
│  进程 A 尝试获取锁                       │
│  ├─ 检查锁文件是否存在                   │
│  ├─ 如果存在，检查是否超时               │
│  ├─ 创建锁文件（原子操作）               │
│  ├─ 验证锁所有权                         │
│  └─ 成功获取锁                           │
└─────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────┐
│  执行关键操作（同步或合并）              │
└─────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────┐
│  释放锁                                  │
│  └─ 验证所有权并删除锁文件               │
└─────────────────────────────────────────┘
```

## 存储结构

```
storage-root/
├── data/                      # 原始数据文件
│   ├── data-2024-01-01T10-00-00-000Z.json
│   ├── data-2024-01-02T11-00-00-000Z.json
│   └── data-2024-01-03T12-00-00-000Z.json
└── merged/                    # 合并后的文件
    └── merged-2024-01-04T13-00-00-000Z.json
```
> 本地缓存（`remote-rev-cache` / `processed-files` / `lastPushedSeq`）位于 PouchDB 的 `_local` 文档，不在此目录中。

## 版本控制策略

### 文档版本

每个文档使用 PouchDB 的 `_rev` 字段来标识版本：
- 格式：`generation-哈希值`（如 `1-abc123`）
- generation 越大表示版本越新
- 同步时总是保留最新版本

### 无文件序列号（rev2 变更）

rev2 设计取消了数据文件 / manifest 的全局序列号：
- 文件命名与内容中均无 `sequence` / `startSeq` / `endSeq`
- "写到第几代"由每个文档 `_rev.generation` 表达
- 增量同步由 `_local` 缓存驱动（见 sync-design-rev2.md）

## 性能优化

### 1. 文件分片

- 单个文件不超过配置的最大大小（默认 1MB）
- 按文档批次自动分片
- 避免下载和解析过大的文件

### 2. 文件合并

- 自动合并小于阈值的文件（默认 100KB）
- 合并同目录的小文件（不要求序列号连续）
- 合并后删除/归档源 data 文件 + 清理 processed-files 条目
- 读取时按 `_rev` 取最新（不再靠"合并文件优先"隐式顺序）

### 3. 增量同步

- 首次同步从最新数据开始
- 后续同步靠 `processed-files`（pull）与 `remote-rev-cache`（push）实现增量
- 减少数据传输和处理时间

### 4. 并发优化

- 使用锁避免不必要的重复操作
- 支持多个读取者并发访问
- 写入操作串行化

## 扩展性

### 文件系统适配

通过 `IFileSystem` 接口，可以支持任何兼容的文件系统实现：

```typescript
interface IFileSystem {
  readFile(path: string, encoding: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<Stats>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
```

### 自定义配置

支持通过 `SyncOptions` 自定义行为：

```typescript
interface SyncOptions {
  basePath: string;                  // 存储根路径
  maxFileSize?: number;              // 最大文件大小（单文件体积上限，超则拆多个 data 文件）
  mergeThreshold?: number;           // 合并阈值
  mergeCheckInterval?: number;            // 合并检查间隔
  autoMerge?: boolean;               // 是否自动合并
}
```

## 安全性考虑

1. **原子性写入**: 使用临时文件+重命名确保写入原子性
2. **锁超时**: 防止死锁
3. **版本验证**: 防止旧数据覆盖新数据
4. **错误恢复**: 损坏的文件不影响整体功能

## 未来改进

1. 支持文件压缩
2. 支持加密存储
3. 支持远程同步协议
4. 支持更细粒度的冲突解决策略
5. 支持数据迁移和版本升级
