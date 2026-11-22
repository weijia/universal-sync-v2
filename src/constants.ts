/**
 * 版本号常量
 */
export const STORAGE_VERSION = '2.0.0';

/**
 * 默认配置
 */
export const DEFAULT_CONFIG = {
  maxFileSize: 2 * 1024 * 1024, // 2MB（单文件体积上限）
  mergeThreshold: 100 * 1024, // 100KB
  // 合并检查间隔：每小时检查一次"是否有上个月及更早的 data 文件需要合并"。
  // 合并语义为「每月合并上个月的数据」，本月新写入的 data 不立即合并，留到下个月处理。
  mergeCheckInterval: 3600 * 1000, // 1 小时检查一次
  autoMerge: true,
};

/**
 * 跨设备合并协调：用 WebDAV 上的「已合并到哪个月」标记文件避免不同电脑/时区重复合并。
 * 语义：合并动作只汇总「当前月之前（上月及更早）」的 data 文件，本月新写入的 data 留到下月。
 * 标记文件名形如 `merged/merged-up-to-2026-07.json`，表示「2026-07 及更早的数据已汇总」，
 * 内容为本机 UTC 写入时间戳，便于审计。统一用 UTC 月份（而非本地时区），确保全球设备看同一份"月份"日历。
 * 同时兼容旧版 `.last-merge-YYYY-MM` 标记（视为已合并）。
 */
export const MERGE_UP_TO_PREFIX = 'merged-up-to-';
export const MERGE_MONTH_LOCK_PREFIX = '.last-merge-'; // 旧版兼容

/**
 * 文件名模式（rev2：文件名含 timestamp + 随机后缀，不含 sequence）
 *
 * `{suffix}` 为 8 位随机串：同毫秒的两个写者也不会撞名，这是无锁方案的前提。
 * `lock` 仅为兼容 browser 测试页的过滤逻辑保留，引擎不再产生锁文件。
 */
export const FILE_PATTERNS = {
  data: 'data-{timestamp}-{suffix}.json',
  merged: 'merged-{timestamp}-{suffix}.json',
  lock: '.lock',
};

/**
 * 目录结构（rev2：local 用于存放 _local 缓存的引用，实际缓存在 PouchDB _local 文档中）
 */
export const DIRECTORIES = {
  data: 'data',
  merged: 'merged',
  archive: 'archive',
  local: 'local',
};
