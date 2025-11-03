import PouchDB from 'pouchdb-core';
import { IFileSystem, SyncOptions } from './types.js';
import { SyncEngine } from './core/sync-engine.js';

/**
 * 主同步接口
 * 
 * @param db - PouchDB 实例
 * @param fs - 文件系统实例（兼容 Node.js fs 的接口）
 * @param basePath - 存储根目录路径
 * @param options - 可选的同步选项
 * 
 * @example
 * ```typescript
 * // Node.js 环境
 * import { sync } from 'universal-sync-v2';
 * import PouchDB from 'pouchdb';
 * import * as fs from 'fs/promises';
 * 
 * const db = new PouchDB('mydb');
 * await sync(db, fs, '/path/to/storage');
 * ```
 * 
 * @example
 * ```typescript
 * // 浏览器环境
 * import { sync } from 'universal-sync-v2';
 * import PouchDB from 'pouchdb';
 * import { fs } from '@zenfs/core';
 * 
 * const db = new PouchDB('mydb');
 * await sync(db, fs.promises, '/storage');
 * ```
 */
export async function sync(
  db: PouchDB.Database,
  fs: IFileSystem,
  basePath: string,
  options?: Partial<SyncOptions>
): Promise<void> {
  const syncOptions: SyncOptions = {
    basePath,
    ...options,
  };

  const engine = new SyncEngine(db, fs, syncOptions);

  await engine.initialize();
  await engine.sync();
}

// 导出类型
export * from './types.js';
export { SyncEngine } from './core/sync-engine.js';
export { StorageManager } from './core/storage-manager.js';
export { ManifestManager } from './core/manifest-manager.js';
export { LockManager } from './core/lock-manager.js';

// 导出浏览器辅助函数
export { syncBrowser, createBrowserFS } from './browser.js';
export type { BrowserSyncOptions } from './browser.js';
