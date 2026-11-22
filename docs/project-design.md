# Universal Sync V2 项目设计（现状版）

> 本文档是本仓库的**单一事实来源（Single Source of Truth）**，按当前代码（v1.0.21，STORAGE_VERSION `2.0.0`）描述设计。
> 与其它文档冲突时，以本文为准：
> - `docs/architecture.md` 的模块图与"分布式锁"章节已按本文更新；
> - `docs/sync-design-rev2.md` 是算法演进记录（rev2：去 manifest / 去全局 sequence），与本文一致；
> - `PROJECT_SUMMARY.md` 是 v1 阶段的历史快照（含 manifest、目录重排、不删源文件等已废弃方案），仅作考古参考。

## 1. 目标与非目标

**目标**

1. 用 PouchDB 的文档模型（`_rev`）在"普通 JSON 文件 + 任意文件系统"上做多设备双向同步。
2. 文件系统只要求最小接口（`IFileSystem`：readFile / writeFile / readdir / mkdir / stat / unlink / rename / exists），Node 与浏览器（zen-fs / WebDAV / IndexedDB）共用一套代码。
3. 共享存储上不存在需要"就地更新"的元数据文件（无 manifest、无全局 sequence、无索引、无锁文件）。
4. 单文件体积可控（`maxFileSize`），历史文件不会无限膨胀（月度合并）。

**非目标**

1. 不追求秒级实时同步；一次 `sync()` 是一次快照式对账。
2. 不追求强一致；以"最终收敛"为正确性标准。
3. 不引入 PouchDB 原生 replication / `_conflicts` 机制；冲突由本库手写归档。
4. 不保证跨设备毫秒级时钟一致；时钟只影响分片路径，不影响正确性。

## 2. 模块与依赖

```
sync(db, fs, basePath, options?)        index.ts / browser-entry.ts
      │
      ▼
SyncEngine (core/sync-engine.ts)
      ├── StorageManager (core/storage-manager.ts)   文件读写 / 分片 / 合并
      └── LocalCache     (core/local-cache.ts)       三个 _local 缓存文档
      │
      ▼
FileSystemUtils (utils/fs-utils.ts)    原子写（随机 tmp + rename）
IFileSystem                            Node fs.promises / zen-fs
```

`LockManager` 已从引擎移除（不再 import / 不再 `withLock`），只在 `index.ts` 以 `@deprecated` 导出，供旧调用方平滑过渡。进程内串行由 `syncInProgress` / `mergeInProgress` 承担，见 §7.3。

## 3. 存储布局

```
basePath/
├── data/YYYY/MM/DD/data-<ISO ts>-<suffix>.json    # 追加写入（唯一写入路径）
├── merged/YYYY/merged-<ISO ts>-<suffix>.json      # 合并产物（追加写入）
├── merged/merged-up-to-YYYY-MM                    # 月份标记（无 .json 后缀，天然被 isMergedFile 排除）
├── merged/.last-merge-YYYY-MM                     # 旧版标记，仅兼容读取
└── archive/<原 data 相对路径>                      # 合并后被移走的源文件（不参与扫描）
```

- `data` 分片按文件自身 timestamp 的 **UTC** 年月日计算，写入即分片（rev2 取消了两阶段"先写根目录、再重排"）。
- 文件名 = `formatTimestamp`（`toISOString().replace(/[:.]/g, '-')`，毫秒精度）+ 8 位 base36 随机后缀：**唯一性靠命名，不靠互斥**（同毫秒的两个写者也不会撞名）。
- 一次 push 若差异集超过 `maxFileSize` 会拆成多个分片，分片 timestamp 依次 `+1ms`，且每片独立随机后缀。
- `local/` 目录常量保留但未使用——缓存实际存放在 PouchDB 的 `_local` 文档里，不落在共享存储上。

**本地缓存（不进共享存储、不参与 replication，每次 put 覆盖）**

| `_local` 文档 id | 内容 | 作用 |
|---|---|---|
| `_local/sync-remote-rev:${basePath}` | `{ revs: { docId: _rev } }` | push 差异筛选的基准 |
| `_local/sync-processed-files:${basePath}` | `{ hashes: { filePath: hash } }` | pull 跳过未变文件 |
| `_local/sync-seq:${basePath}` | `{ lastPushedSeq }` | push 的 `update_seq` 轻量跳过 + 删除收集的起点 |

三者丢失都只是"变慢"（退化为全量比对），不影响正确性。

## 4. 版本模型

正确性只依赖 PouchDB 的 `_rev = "generation-hash"`：

- 同 id 取 `generation` 大者；
- 有 `_revisions` 时先判祖先关系（`revisionsContain`），避免"分叉被误判成更新"；
- 同 generation 不同 hash → `conflict`，由 `keep-conflict` 生成 `sync_conflict:<id>:<rev>` 归档文档，原文档保持不动。

**pull 复制语义**：远端文档原样带 `_rev/_revisions/_deleted` 用 `bulkDocs(..., { new_edits: false })` 写入，两台设备的 rev 完全一致。
**pull 编辑语义**：合并结果/冲突归档走本地新修订（`new_edits: true`）。

`new_edits:false` 没有 `_revisions` 会被 PouchDB 静默忽略，因此 `prepareDocForReplication()` 在缺失时按 `_rev` 合成单元素链。

## 5. 同步算法

### 5.1 Push（PouchDB → 文件）

```
1. 轻量跳过：_local/sync-seq.lastPushedSeq >= db.info().update_seq → 直接返回
2. remote-rev-cache 为空 → 扫 data/ + merged/ 全部文档，按 id 取 generation 最大者重建
3. allDocs({ include_docs: true, update_seq: true }) 取本地全量（不含墓碑）
4. 差异筛选 filterPushDiff：
     - 远端无该 id                → 推送
     - rev 相同                    → 跳过
     - _revisions 显示远端 rev 是后代 → 跳过（本地更旧）
     - 否则 generation 比较
5. 墓碑单独从 changes({ since: lastSeq, include_docs: true }) 收集
     （allDocs 不返回已删除文档；远端已是同一墓碑 rev 的跳过）
6. writeDocuments 按 maxFileSize 切分片，逐个原子写入 data/YYYY/MM/DD/
7. 回写 remote-rev-cache 与 lastPushedSeq
```

### 5.2 Pull（文件 → PouchDB）

```
1. listAllDataFiles：按 data/merged 的 YYYY/MM/DD 层级下钻；结果为空时启用全树枚举兜底
2. processed-files 的 contentHash 未变 → 跳过（FNV-1a 32bit，仅性能优化）
3. 逐文档 resolvePullDocument：
     - 本地无该 doc 且远端是墓碑 → 跳过（避免复活已删文档）
     - 本地无该 doc             → 原 rev 复刻
     - 否则 compareDocumentRevisions → use-remote / use-local / merge / keep-conflict
4. bulkDocs 批量应用（复制批与编辑批分开）
5. 回写 processed-files 与 remote-rev-cache
```

### 5.3 合并（月度合并）

```
1. hasMergedThisMonth()：merged/merged-up-to-<上月 UTC> 存在则跳过（并兼容旧 .last-merge-<上月>）
2. findMergeCandidates()：只取 data 下文件名月份 < 当前 UTC 月的文件，按累计体积 ≤ maxFileSize 分批
3. mergeFiles(group)：
     读全部文档 → latestByRev 去重 → 写 merged/YYYY/merged-<ts>.json
     → 源文件移入 archive（rename，失败降级"读+写+删源"，两者都失败则保留源文件）
     → 自底向上清理空日期目录 → 写月份标记
```

合并语义是"每月汇总上个月及更早的数据"，本月 data 留到下月；`performMerge(true)` 可强制包含本月（手动/测试用）。

## 6. 失败与退化边界

| 场景 | 行为 |
|---|---|
| 缓存丢失 | 退化为全量扫描/比对，慢但正确 |
| 单个文件 JSON 损坏 | 读侧 `catch` 静默跳过该文件（其余文件继续），见 §7 风险 R1 |
| WebDAV 把集合自身当子条目返回 | `collectShardFiles` 按层级正则过滤 + `fallbackListAll` 防自引用 |
| `rename` 跨集合不支持 | 归档降级为"复制 + 删源"，失败则保留源文件，绝不丢数据 |
| 时钟偏差 | 文件落到非预期日期分片；不影响版本判定，只影响分片美观与"本月不合并"的边界 |
| 进程崩溃 | 无锁残留；未完成的 `.tmp` 文件因 `isDataFile/isMergedFile` 要求 `.json` 结尾而被忽略 |

## 7. 并发模型：为什么不需要跨进程锁（已确认）

**结论**：跨设备文件锁对正确性没有贡献，且它连"合并 vs 拉取"这条最需要保护的路径都没覆盖——`sync()` 用 `.sync.lock`、`performMerge()` 用 `.merge.lock`，两者名字不同，本来就不互斥。

**实施状态：已完成。** 引擎已移除 `withLock`；文件名与原子写临时名已加随机后缀；`tsc --noEmit` 通过、58 个 jest 用例全绿、`dist/` 与三个浏览器 bundle 已重建。

### 7.1 证据：每个操作对共享存储的实际影响

| 操作 | 对共享存储的动作 | 是否追加 | 结论 |
|---|---|---|---|
| push 写 data 分片 | 新建文件 + 原子 rename | 是 | 无需互斥（前置条件：文件名唯一） |
| pull | 只读 | — | 无需互斥 |
| merge 写 merged 文件 | 新建文件 | 是 | 无需互斥（幂等，见 I6） |
| merge 移源文件到 archive | rename / unlink 已有文件 | **否** | 会重复劳动，但不丢数据（最坏产生冗余 merged 文件） |
| merge 写月份标记 | 覆盖写同一路径 | **否** | 内容幂等，覆盖无害 |
| LockManager | 新建/读/删 `.lock` | 否 | 本身就是竞态源 |

真正保证正确性的是三件事，锁都不在其中：

1. **追加写**：`data/`、`merged/` 下从不就地改写任何已存在的数据文件；
2. **`_rev` 比较**：新旧/冲突只看版本链，与文件顺序、文件时间、谁先写无关；
3. **合并幂等**：同一文档出现在多个 merged 文件里，读侧 `latestByRev` 去重后结果一致。

### 7.2 原锁实现的问题（已随移除一并消失）

- **不可靠的"互斥"**：`acquireLock` 是"writeFile + sleep(1000) + 读回校验"。WebDAV 上读写可能落在不同副本/缓存，两台设备都可能读回自己的 id，于是**都认为自己拿到了锁**。它给的是心理安慰，不是保证。
- **错误的失败语义**：`maxRetries=30 × retryDelay=1s`，抢不到锁超时后直接 `throw`，会把一次本可正常完成的 `sync()` 变成失败。
- **无谓延迟**：每次获取锁至少 1s 校验延迟（内存 FS 为 0，WebDAV 为 1s），同步被拉长。
- **不覆盖关键路径**：`sync` 与 `merge` 两把锁名不同，同一设备上定时合并与正在进行的同步可以并发执行；另一台设备的合并也不会被本设备的同步挡住——而"合并移动源文件"正是唯一非追加的高风险动作。

### 7.3 真正需要的：进程内串行（内存互斥）

JavaScript 单线程下，"先判断再置位、中间无 `await`"就是有效的互斥：

```ts
if (this.syncInProgress) return;
this.syncInProgress = true;   // 同步赋值，无竞态窗口
```

`syncInProgress` 覆盖 `sync()` 与 `pull()`，`mergeInProgress` 覆盖 `performMerge()`。为避免"合并移动源文件"与"拉取读源文件"交叉，`performMerge()` 现在额外做两件事：`syncInProgress` 为真时直接跳过本次；先把 `mergeInProgress` 置位再 `await`，两个并发合并调用不会都通过检查。

### 7.4 前提条件：写入路径必须全局唯一（已落地）

如果文件名会撞，"不需要锁"就不成立——这是唯一还可能导致**真实丢数据**的场景：

- 文件名只有毫秒 timestamp 时：两台设备在同一毫秒各自 push，会生成同名 `data-<ts>.json`；
- `atomicWrite` 的临时名若固定为 `${path}.tmp`：同名时两个写者写同一个 tmp 路径。两种后果：
  ① 后 rename 的一方因 tmp 已被前一次 `rename` 掉而失败（ENOENT）→ 它的 push 抛错、`remote-rev-cache` 不更新，下次会重推，只是噪音；
  ② 更糟的是**先 rename 成功、但内容已被对方覆盖**——这一方把自己的 rev 记进了 `remote-rev-cache`，而自己的文档在共享存储里并不存在，于是**不会再有重推机会**。
- 读侧的容错让问题更难暴露：`readJSON` 抛错时，pull 的 `readChangedDocs` 与 `readDocumentsFromFiles` 都 `catch` 跳过该文件，里面的文档就此从共享存储里"消失"。

所以无锁方案的前提是：**把唯一性从"互斥"换成"命名"**。已落地两项：

1. 数据/合并文件名加随机片段：`data-<ISO ts>-<8位随机>.json`、`merged-<ISO ts>-<8位随机>.json`（`monthKeyOfDataFile` 的前缀正则与 `isDataFile/isMergedFile` 的后缀判断天然兼容）。
2. `atomicWrite` 的临时名同样加随机：`${path}.<8位随机>.tmp`。
3. 兜底（未做，可选）：写完后读回校验一次，失败则从 `remote-rev-cache` 回滚该批 rev，让下一次 push 重推。

### 7.5 残余风险（无锁后仍需知道）

- **R1（已消除）**：命名碰撞风险已由 §7.4 的随机后缀消除，`__tests__/no-lock-and-unique-names.test.ts` 覆盖"同一毫秒两次写入生成不同文件名"。
- **R2（冗余）**：两台设备同时合并 → 两个 merged 文件，其中一台可能因源文件已被移走而生成不完整的 merged；数据仍在另一台的 merged 与 archive 中，最终收敛，仅多一次读。
- **R3（时钟）**：文件名 timestamp 来自设备本地时钟，时钟偏差只影响分片路径与月度合并边界，不影响版本判定。
- **R4（已消除）**：锁等待/超时导致的 `sync()` 失败，去掉锁后不存在。

### 7.6 移除与加固（已执行）

| 文件 | 改动 |
|---|---|
| `src/core/sync-engine.ts` | 删除 `LockManager` 的 import / 字段 / 构造；`pull() / sync() / performMerge()` 去掉 `withLock` 包装 |
| `src/core/sync-engine.ts` | `performMerge()`：`syncInProgress` 时跳过；先置位 `mergeInProgress` 再 `await`；月份标记只检查一次 |
| `src/utils/helpers.ts` | 新增 `uniqueSuffix()`（8 位 base36）；`parseTimestampFromFilename()` 兼容带/不带后缀 |
| `src/utils/fs-utils.ts` | `atomicWrite()` 临时名改为 `${path}.<suffix>.tmp` |
| `src/core/storage-manager.ts` | `data` / `merged` 文件名改为 `...-<suffix>.json`（`buildFileName()` 统一拼装） |
| `src/constants.ts` | `FILE_PATTERNS` 模板加 `{suffix}`；`lock` 键保留（仅 browser 测试页过滤用） |
| `src/index.ts` | `LockManager` 导出标注 `@deprecated` |
| `__tests__/no-lock-and-unique-names.test.ts` | 新增 6 个用例：同毫秒不撞名、后缀格式、时间戳解析兼容、`.tmp` 不被识别、sync/merge 不产生锁文件、并发合并不重复 |

验证：`npx tsc --noEmit` 通过；`npx jest` 6 套 / 58 用例全绿；`npm run build` 重建 `dist/` 与 3 个浏览器 bundle。

### 7.7 不变量（评审/测试用 checklist）

- **I1** 共享存储上的数据文件、合并文件只新建，不就地修改。
- **I2** 写入文件名跨设备、跨进程、同毫秒唯一（§7.4 修完后成立）。
- **I3** 原子写的临时文件名唯一。
- **I4** 任何写操作都不以"是否拿到锁"作为可否写入的判断依据。
- **I5** 新旧与冲突判定只依赖 `_rev`（含 `_revisions` 祖先链）。
- **I6** 合并幂等：同一文档多份副本按 `_rev` 去重后结果不变。
- **I7** 读侧必须容忍损坏/缺失文件（跳过而非中断），并且这个"跳过"必须由 I2 兜底。

## 8. 已知债务

1. `dist/` 在 `.gitignore` 里，发布前必须 `npm run build`（本次已重建）。浏览器 bundle 与 userscript 构建产物同理。
2. `PROJECT_SUMMARY.md` 仍描述 v1（manifest / 目录重排 / "不删除原始文件" / "优先读取合并文件"），与 rev2 相反（文件头已加提示）。
3. `mergeThreshold`（默认 100KB）目前未参与候选判定——`findMergeCandidates` 只看"文件月份早于当前 UTC 月" + 体积分批（`maxFileSize`）。配置项与实现不一致（`requirements.md` 需求 17 因此偏乐观）。
4. `requirements.md` 的统计数字已按逐行状态校正（✅ 41 / ❌ 24），但历史条目（如"合并后删除 processed-files 条目"）未逐条复核。
