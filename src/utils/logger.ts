/**
 * 统一日志入口，基于 @richard432/localstorage-logger。
 *
 * 每个「小模块」对应一个独立的 localStorage 开关键：`debug:<module>`。
 *   - 键不存在：自动创建并默认开启（值为 '1'）
 *   - 值为 '1'：输出日志
 *   - 值为 '0'：静默
 *
 * 浏览器控制台手动开关示例：
 *   localStorage.setItem('debug:storage-manager', '0');
 *   localStorage.setItem('debug:storage-manager', '1');
 *
 * 也提供程序化 API：setDebugEnabled / isDebugEnabled / listDebugModules。
 * 顶层开关 `debug:universal-sync` 可一键控制全部子模块（默认开启）。
 */
import {
  createLogger,
  setDebugEnabled,
  isDebugEnabled,
  listDebugModules,
} from '@richard432/localstorage-logger';

/** 顶层总开关：控制整个库的所有日志（默认开启） */
export const MODULE_ROOT = 'universal-sync';

/** 各小模块开关 */
export const MODULE_SYNC_ENGINE = 'sync-engine';
export const MODULE_STORAGE_MANAGER = 'storage-manager';
export const MODULE_LOCAL_CACHE = 'local-cache';
export const MODULE_LOCK_MANAGER = 'lock-manager';
export const MODULE_FS_UTILS = 'fs-utils';
export const MODULE_FS_RAW = 'fs-raw';
export const MODULE_HELPERS = 'helpers';
export const MODULE_MEMORY_POUCH = 'memory-pouch';

export const logRoot = createLogger(MODULE_ROOT);
export const logSyncEngine = createLogger(MODULE_SYNC_ENGINE);
export const logStorageManager = createLogger(MODULE_STORAGE_MANAGER);
export const logLocalCache = createLogger(MODULE_LOCAL_CACHE);
export const logLockManager = createLogger(MODULE_LOCK_MANAGER);
export const logFsUtils = createLogger(MODULE_FS_UTILS);
export const logFsRaw = createLogger(MODULE_FS_RAW);
export const logHelpers = createLogger(MODULE_HELPERS);
export const logMemoryPouch = createLogger(MODULE_MEMORY_POUCH);

export { setDebugEnabled, isDebugEnabled, listDebugModules };
