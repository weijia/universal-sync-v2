/**
 * 统一日志入口，基于 @richard432/localstorage-logger。
 *
 * 每个日志模块对应一个 localStorage 开关键：`debug:<module>`。
 *   - 键不存在：自动创建并默认开启（值为 '1'）
 *   - 值为 '1'：输出日志
 *   - 值为 '0'：静默
 *
 * 浏览器控制台手动开关示例：
 *   localStorage.setItem('debug:storage-manager', '0');
 *   localStorage.setItem('debug:storage-manager', '1');
 *
 * 也提供程序化 API：setDebugEnabled / isDebugEnabled / listDebugModules。
 */
import {
  createLogger,
  setDebugEnabled,
  isDebugEnabled,
  listDebugModules,
} from '@richard432/localstorage-logger';

export const MODULE_STORAGE_MANAGER = 'storage-manager';
export const MODULE_SYNC_ENGINE = 'sync-engine';
export const MODULE_FS_RAW = 'fs-raw';

export const logStorageManager = createLogger(MODULE_STORAGE_MANAGER);
export const logSyncEngine = createLogger(MODULE_SYNC_ENGINE);
export const logFsRaw = createLogger(MODULE_FS_RAW);

export { setDebugEnabled, isDebugEnabled, listDebugModules };
