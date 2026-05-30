# 需求文档

## 一、核心功能需求

| # | 需求 | 来源文档 | 实现状态 |
|---|------|---------|---------|
| 1 | 跨平台支持（Node.js + 浏览器） | architecture.md | ✅ 已实现 |
| 2 | PouchDB 与 JSON 文件双向同步 | sync-process.md | ✅ 已实现 |
| 3 | 版本控制（基于 `_rev`），防止旧数据覆盖新数据 | sync-process.md | ✅ 已实现 |
| 4 | 智能分片（单文件不超过 maxFileSize，默认 1MB） | storage-format.md | ✅ 已实现 |
| 5 | 增量同步（基于序列号，只读取新文件） | sync-process.md | ✅ 已实现（有性能问题） |
| 6 | 文件合并（自动合并小于阈值的小文件） | file-merging.md | ✅ 已实现 |
| 7 | 并发安全（分布式锁，防止竞争条件） | sync-process.md | ✅ 已实现 |
| 8 | 原子性写入（临时文件 + 重命名） | sync-process.md | ✅ 已实现 |
| 9 | 单一 `sync()` 接口，简单易用 | api.md | ✅ 已实现 |

## 二、存储格式需求

| # | 需求 | 来源文档 | 实现状态 |
|---|------|---------|---------|
| 10 | 清单文件 `manifest.json` 记录所有文件元数据 | storage-format.md | ✅ 已实现 |
| 11 | 数据文件格式 `data-*.json` 包含版本、时间戳、文档数组 | storage-format.md | ✅ 已实现 |
| 12 | 合并文件格式 `merged-*.json` 包含 `mergedFrom` 源文件列表 | storage-format.md | ✅ 已实现 |
| 13 | 文件命名规则：`data-{seq}-{timestamp}.json` | storage-format.md | ✅ 已实现 |
| 14 | 序列号全局递增，记录在 manifest 的 `lastSequence` | storage-format.md | ✅ 已实现 |
| 15 | 锁文件格式 `.{lockName}.lock`，含 id、timestamp、operation | storage-format.md | ✅ 已实现 |
| 16 | 锁超时默认 30 秒，防止死锁 | storage-format.md | ✅ 已实现 |

## 三、文件合并需求

| # | 需求 | 来源文档 | 实现状态 |
|---|------|---------|---------|
| 17 | 合并条件：文件大小 < 阈值（默认 100KB） | file-merging.md | ✅ 已实现 |
| 18 | 合并条件：序列号连续 | file-merging.md | ✅ 已实现 |
| 19 | 合并条件：未被标记为已合并 | file-merging.md | ✅ 已实现 |
| 20 | 合并后大小不超过 maxFileSize | file-merging.md | ✅ 已实现 |
| 21 | 合并时去重，同一文档 ID 只保留最新版本 | file-merging.md | ✅ 已实现 |
| 22 | 读取时优先使用合并文件 | file-merging.md | ✅ 已实现 |
| 23 | 自动合并（定期扫描，默认 60 秒） | file-merging.md | ✅ 已实现 |
| 24 | 手动合并 `performMerge()` | file-merging.md | ✅ 已实现 |
| 25 | 合并失败不影响原始文件和清单 | file-merging.md | ✅ 已实现 |

## 四、目录重组需求

| # | 需求 | 来源文档 | 实现状态 |
|---|------|---------|---------|
| 26 | 新文件直接写根目录，由重排机制整理到分区 | storage-format.md | ✅ 已实现 |
| 27 | 自动检测目录文件数，超过阈值触发重排（默认 100） | storage-format.md | ✅ 已实现 |
| 28 | 按时间戳迁移到 `YYYY/MM/` 分区目录 | storage-format.md | ✅ 已实现 |
| 29 | 每次重排最大文件数限制（默认 50） | storage-format.md | ✅ 已实现 |
| 30 | 支持 dryRun 模拟模式 | storage-format.md | ✅ 已实现 |
| 31 | 回滚机制：manifest 更新失败则删除新文件 | storage-format.md | ✅ 已实现 |
| 32 | 使用分布式锁确保并发安全 | storage-format.md | ✅ 已实现 |
| 33 | `shouldReorganize()` 检查是否需要重排 | storage-format.md | ✅ 已实现 |
| 34 | `getDirectoryStats()` 获取目录统计信息 | storage-format.md | ✅ 已实现 |
| 35 | `reorgBatchSize` 可配置 | storage-format.md | ✅ 已实现 |

## 五、分区存储需求（部分未实现）

| # | 需求 | 来源文档 | 实现状态 |
|---|------|---------|---------|
| 36 | 分区目录结构 `data/YYYY/MM/` 或 `data/YYYY/MM/DD/` | storage-format.md | ⚠️ 重组时支持，写入时未启用 |
| 37 | 分区 Manifest（每个分区独立 manifest） | storage-format.md | ❌ 未实现 |
| 38 | 全局索引 `manifest-index.json` 记录各分区信息 | storage-format.md | ❌ 未实现 |
| 39 | 分区层级可配置（year/month、year/month/day 等） | storage-format.md | ❌ 未实现 |
| 40 | 从单一 manifest 迁移到分区 manifest 的工具 | storage-format.md | ❌ 未实现 |
| 41 | 混合模式：同时识别根目录 manifest 与分区 manifest | storage-format.md | ❌ 未实现 |

## 六、API 需求

| # | 需求 | 来源文档 | 实现状态 |
|---|------|---------|---------|
| 42 | `sync(db, fs, basePath, options?)` 主接口 | api.md | ✅ 已实现 |
| 43 | `SyncEngine` 高级 API（initialize/sync/performMerge/cleanup） | api.md | ✅ 已实现 |
| 44 | `StorageManager` 高级 API（writeDocuments/readAllDocuments 等） | api.md | ✅ 已实现 |
| 45 | `ManifestManager` 高级 API（readManifest/addFile/updateFile 等） | api.md | ✅ 已实现 |
| 46 | `LockManager` 高级 API（acquireLock/releaseLock/withLock） | api.md | ✅ 已实现 |
| 47 | `IFileSystem` 接口（readFile/writeFile/readdir/mkdir 等） | api.md | ✅ 已实现 |
| 48 | `SyncOptions` 配置（maxFileSize/mergeThreshold/autoMerge 等） | api.md | ✅ 已实现 |

## 七、故障恢复需求

| # | 需求 | 来源文档 | 实现状态 |
|---|------|---------|---------|
| 49 | 清单文件损坏时从数据文件重建 | storage-format.md | ❌ 未实现 |
| 50 | 数据文件损坏时跳过并记录错误 | storage-format.md | ✅ 已实现 |
| 51 | 锁文件残留超时自动清理 | storage-format.md | ✅ 已实现 |
| 52 | 版本兼容性检查与迁移 | storage-format.md | ❌ 未实现 |

## 八、浏览器环境需求

| # | 需求 | 来源文档 | 实现状态 |
|---|------|---------|---------|
| 53 | 支持 WebDAV 文件系统（通过 zen-fs） | browser-usage.md | ✅ 已实现 |
| 54 | 支持 IndexedDB 文件系统 | browser-usage.md | ✅ 已实现 |
| 55 | 支持 BrowserFS | api.md | ✅ 已实现 |
| 56 | CDN 直接导入 | browser-usage.md | ✅ 已实现 |
| 57 | Import Maps 支持 | browser-usage.md | ✅ 已实现 |

## 九、未来改进需求

| # | 需求 | 来源文档 | 实现状态 |
|---|------|---------|---------|
| 58 | 文件压缩 | architecture.md | ❌ 未实现 |
| 59 | 加密存储 | architecture.md | ❌ 未实现 |
| 60 | 远程同步协议 | architecture.md | ❌ 未实现 |
| 61 | 更细粒度的冲突解决策略 | architecture.md | ❌ 未实现 |
| 62 | 数据迁移和版本升级工具 | architecture.md | ❌ 未实现 |

---

## 统计

- **总需求**：62 项
- **已实现**：49 项（✅）
- **部分实现**：1 项（⚠️）
- **未实现**：12 项（❌）
