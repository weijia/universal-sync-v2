# 同步设计 V2（rev2：基于 _rev 的差异同步，去 manifest / 去全局 sequence）

> 本文档是 universal-sync-v2 同步算法的**目标设计**。它取代旧设计中对"全局 sequence + manifest.json 作为增量游标"的依赖。
> 配套文档：`storage-format.md`（文件格式）、`sync-process.md`（流程）。

## 1. 设计目标

1. **去掉全局 sequence**：不再维护 `manifest.lastSequence`、文件命名里的 `startSeq/endSeq`、`DataFileContent.sequence`。
2. **去掉 manifest.json / manifest-index.json**：文件发现改为"列出 `data/` 与 `merged/` 目录下所有 `*.json`"。
3. **以文档自身 `_rev` 作为唯一版本判据**：PouchDB 文档天然带 `_rev = "generation-hash"`，用它判断新旧、冲突、删除。
4. **引入两个本地 `_local` 文档做缓存**（不进目标文件系统、不参与 replication、Node/浏览器兼容）。

## 2. 两个本地缓存（`_local` 文档）

复用现有 `_local` 机制（`db.get/put`，id 用 `safeBasePath` 派生，与现有 `localSeqDocId` 一致）。两个缓存都**存在本地 PouchDB、不写入目标文件系统**。

| 文档 id | 内容 | 作用 |
|---|---|---|
| `_local/sync-remote-rev:${basePath}` | `{ revs: { [docId]: _rev } }` | **push 差异筛选**；pull 后回写，保持与目标文件系统一致 |
| `_local/sync-processed-files:${basePath}` | `{ files: { [filename]: contentHash } }` | **pull 跳过未变文件** |
| `_local/sync-seq:${basePath}`（保留） | `{ lastPushedSeq }` | **push 轻量跳过**：`db.info().update_seq` 无变化时直接跳过整次 push（性能优化，不依赖 manifest） |

> 关于 `_local` 文档：它是 PouchDB 中以 `_local/` 开头的特殊文档，不参与 replication、无 `_rev` 版本树（每次 put 覆盖），底层存于 PouchDB adapter（浏览器=IndexedDB，Node=LevelDB 等）。只要生产 db 是持久化 adapter 即跨端兼容；若某场景用内存版 PouchDB，`_local` 重启即丢，但只会退化为"全量比对"，不影响正确性。

## 3. 文件命名与目录

- 数据文件：`data-{timestamp}.json`（`timestamp` 为 ISO 8601 去特殊字符，如 `data-2026-08-14T10-00-00-000Z.json`）。
- 合并文件：`merged-{timestamp}.json`。
- **目录扫描：同时包含 `data/`（含任意分区子目录）与 `merged/`（含任意分区子目录）**，递归列出所有 `*.json`。
- 文件名使用 timestamp（每次 push 写入一个以本次 timestamp 命名的文件），内容不变则文件名不同 → `processed-files` 会视其为新文件；这是预期行为，靠 `performMerge` 压缩历史文件避免膨胀（见 §7）。

## 4. Push 流程（PouchDB → 文件，基于 `_rev` 差异）

```
push()：
  1. 轻量跳过：读 _local/sync-seq 的 lastPushedSeq；
     若 db.info().update_seq === lastPushedSeq → 无本地变更，直接返回。
  2. 初始化 remote-rev-cache：
       cache = 读 _local/sync-remote-rev
       if cache 为空（首次 / 缓存丢失）：
           扫描目标文件系统 data/ + merged/ 全部 *.json，
           对每个 doc 取最新 _rev（同 id 取 generation 最大），
           重建 cache.revs，写回 _local。
  3. 取本地所有 doc（必须含 tombstone！用 allDocs({include_docs:true})，
     不能漏掉 _deleted 文档）。
  4. 对每个本地 doc d：
       - cache.revs 无 d._id            → 标记"需推送"（远端不存在）
       - gen(cache.revs[d._id]) < gen(d._rev) → "需推送"（远端更旧）
       - 否则                            → 跳过
  5. 对"需推送"集合，再与目标文件真实内容 compareDocumentRevisions 一次
     （防 cache 漂移导致的误判/漏判）。
  6. 仅把确认需推送的 doc 写入目标文件系统新文件（一次 push 写一个 data-{timestamp}.json）。
  7. 把已推送 doc 的最新 _rev 更新回 cache.revs，写回 _local/sync-remote-rev。
  8. 更新 _local/sync-seq.lastPushedSeq = db.info().update_seq。
```

### 删除（tombstone）如何被推送

本地删除文档 = `db.put({...doc, _deleted:true})`，生成新的 `_rev`（generation+1）。
该 tombstone 仍可被 `allDocs({include_docs:true})` 取到，`_rev` 比 cache 里记的旧 rev 新
→ 命中"需推送"，无需任何特殊分支。远端收到 `_deleted:true` 后，pull 侧判为 remote-newer → 本地同步删除。

### 为什么 push 前要先初始化 cache

cache 为空（首次运行、或缓存损坏/丢失）时，若直接拿空 cache 筛选，会把所有本地 doc 当差异全推——
虽然结果正确，但：
(a) 浪费一次全量写入；
(b) 更重要的是 cache 没有反映目标文件系统**真实** rev 状态，后续增量判断失去基准。
因此 push 第一步在 cache 为空时必须"扫目标文件系统重建 cache"，使 cache 始终先对齐目标侧真实状态，再做增量比对。

## 5. Pull 流程（文件 → PouchDB，基于 `_rev` + 文件 hash）

```
pull()：
  1. 递归列出 data/ + merged/ 下所有 *.json。
  2. 读 _local/sync-processed-files：
       未出现的 filename / contentHash 变化过的文件 → 需要读取；
       出现过且 hash 相同的文件 → 跳过。
  3. 读取需处理的文件，对每个 doc 与本地 PouchDB 用 compareDocumentRevisions 比较：
       - remote-newer → use-remote（含 _deleted 删除本地）
       - conflict     → keep-conflict（生成 sync_conflict:* 文档，复用现有逻辑）
       - local-newer  → use-local（不动）
  4. 处理完的文件，更新 processed-files[filename] = contentHash，写回 _local。
  5. 用文件里每个 doc 的最新 _rev 回写 remote-rev-cache（与 push 共用，保持一致）。
```

> 注意：pull 以 `processed-files` 的 hash 为"跳过"判据，但**最终正确性由 `_rev` 比较保证**：
> 即使缓存失效（hash 判断错误），重读文件后 `_rev` 比较仍只应用真正更新的文档，不会错。

## 6. compareDocumentRevisions（复用现有实现，不重写）

引擎已实现的 `compareDocumentRevisions` + `resolveIncomingDocument` 逻辑完全保留：
它基于 `_rev`（含 `_revisions` 祖先链 / generation 数）判定 `same / remote-newer / local-newer / conflict`，
删除文档（`_deleted:true`）走同样的 `_rev` 比较路径。冲突时 `keep-conflict` 生成 `sync_conflict:*` 文档。

**关于 PouchDB 原生 conflict 的说明**：当前不是用 PouchDB replication，而是手写"文件→DB"同步，
因此不会触发 PouchDB 原生的 `_conflicts` 机制；冲突由 `keep-conflict` 手写处理。保持现状，不引入原生 replication。

## 7. 合并（merge）与缓存一致性

`performMerge` 把多个 data 合成一个 merged，内容变化 → merged 文件名 hash 变 → pull 会重读；
旧 data 文件 hash 未变 → 被跳过。为避免历史 data 文件成为永久"死重"，合并后：

1. 删除被合并的源 data 文件（或归档到独立目录，不再参与扫描）；
2. 从 `processed-files` 中移除这些源 data 文件的条目（否则其 hash 永远"已处理"，新合并内容靠 merged 文件覆盖即可，无影响；但清理条目可减少缓存体积）。

合并文件同样遵守 §5 的 `_rev` 取最新规则，不会因重复出现而产生错误写入。

## 8. 退化行为与正确性边界

| 场景 | 行为 |
|---|---|
| `remote-rev-cache` 丢失 | push 退化为"扫目标文件系统重建 cache 后全量比对"，慢但正确 |
| `processed-files` 丢失 | pull 退化为"读全部文件"，慢但正确 |
| 缓存与真实文件系统漂移（另一设备改了远程） | push 第 5 步 `compareDocumentRevisions` 兜底；pull 以文件真实 `_rev` 为准 |
| `_local` 文档所在 db 为内存版 | 重启丢失，退化为全量比对，不影响正确性，仅变慢 |

## 9. 落地清单（已完成）

- [x] `StorageManager`：去掉 `ManifestManager` 依赖；`writeDocuments` 接收差异集并写入即分片；新增 `listAllDataFiles`（递归列目录）、`readFileContent`、`mergeFiles`（列目录候选）、`cleanupArchivedFiles`（删空日期目录）；`readAllDocuments` 改为"列目录 + 读 + 按 `_rev` generation 去重"；删除 `readIncrementalDocuments`。
- [x] `SyncEngine`：push 增加"cache 为空则扫文件系统初始化"（`buildRemoteRevCacheFromFiles`）；push/pull 读写两个 `_local` 缓存；保留 `update_seq` 轻量跳过（`LocalCache.sync-seq`）。
- [x] `LocalCache`：新增 `src/core/local-cache.ts`，统一管理 `remote-rev-cache` / `processed-files` / `sync-seq` 三个 `_local` 文档（id 以 `_local/` 前缀，不进目标文件系统、不参与 replication）。
- [x] `types.ts`：移除 `DataFileMetadata` / `ManifestContent` / `Reorg*` / `DirectoryStats`；`DataFileContent` 去掉 `sequence`；新增 `RemoteRevCache` / `ProcessedFilesCache` / `SyncSeqCache`；`IFileSystem` 增加 `size` / `rmdir`。
- [x] `constants.ts`：`FILE_PATTERNS` 改为 `data-{timestamp}.json` / `merged-{timestamp}.json`；`DIRECTORIES` 增加 `local`；删除重排默认配置。
- [x] 删除 `manifest-manager.ts` / `file-saver.ts`；`index.ts` / `browser-entry.ts` 同步导出。
- [x] 测试覆盖：写入即分片、cache 初始化（空 cache 重建）、tombstone 自然推送、cache 漂移兜底（`_revisions` 祖先判断）、merged 后旧文件清理、冲突解析。
