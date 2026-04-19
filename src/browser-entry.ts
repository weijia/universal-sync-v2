/**
 * 浏览器专用入口文件
 * 使用静态导入以便 esbuild 可以打包所有依赖
 */

import { sync } from './index.js';
import type { IFileSystem, SyncOptions } from './types.js';
import { createWebDAVFileSystem } from 'zen-fs-webdav';
import { configure, fs } from '@zenfs/core';
import { IndexedDB } from '@zenfs/dom';

export interface BrowserSyncOptions {
  /** PouchDB 数据库实例 */
  db: any;
  /** 存储根路径，默认为 '/storage' */
  basePath?: string;
  /** WebDAV 配置（可选） */
  webdav?: {
    baseUrl: string;
    username?: string;
    password?: string;
  };
  /** 是否自动合并文件，默认为 true */
  autoMerge?: boolean;
  /** IndexedDB 存储名称，默认为 'universal-sync-storage' */
  storeName?: string;
}

/**
 * 浏览器环境的简化同步接口
 * 支持 IndexedDB 或 WebDAV 作为存储后端
 * 
 * @example
 * ```typescript
 * // 使用 IndexedDB（本地存储）
 * import { syncBrowser } from 'universal-sync-v2';
 * import PouchDB from 'pouchdb';
 * 
 * const db = new PouchDB('mydb');
 * await syncBrowser({ db });
 * ```
 * 
 * @example
 * ```typescript
 * // 使用 WebDAV（远程存储）
 * import { syncBrowser } from 'universal-sync-v2';
 * import PouchDB from 'pouchdb';
 * 
 * const db = new PouchDB('mydb');
 * await syncBrowser({ 
 *   db,
 *   webdav: {
 *     baseUrl: 'https://webdav.example.com',
 *     username: 'user',
 *     password: 'pass'
 *   }
 * });
 * ```
 */
export async function syncBrowser(options: BrowserSyncOptions): Promise<void> {
  const { 
    db, 
    basePath = '/storage', 
    webdav,
    autoMerge = true,
    storeName = 'universal-sync-storage'
  } = options;

  let fileSystem: IFileSystem;

  if (webdav && webdav.baseUrl) {
    // 使用 WebDAV
    fileSystem = createWebDAVFileSystem({
      baseUrl: webdav.baseUrl,
      username: webdav.username,
      password: webdav.password,
    }) as any;
  } else {
    // 使用 IndexedDB
    await configure({
      mounts: {
        '/': {
          backend: IndexedDB,
          storeName,
        },
      },
    });

    fileSystem = fs.promises as any;
  }

  await sync(db, fileSystem, basePath, {
    autoMerge,
  });
}

/**
 * 创建一个配置好的文件系统实例
 * 用于需要手动控制同步流程的场景
 * 
 * @example
 * ```typescript
 * // 使用 IndexedDB
 * import { createBrowserFS } from 'universal-sync-v2';
 * import { SyncEngine } from 'universal-sync-v2';
 * 
 * const fs = await createBrowserFS();
 * const engine = new SyncEngine(db, fs, { basePath: '/storage' });
 * await engine.initialize();
 * await engine.sync();
 * ```
 * 
 * @example
 * ```typescript
 * // 使用 WebDAV
 * import { createBrowserFS } from 'universal-sync-v2';
 * 
 * const fs = await createBrowserFS({
 *   webdav: {
 *     baseUrl: 'https://webdav.example.com',
 *     username: 'user',
 *     password: 'pass'
 *   }
 * });
 * ```
 */
export async function createBrowserFS(options?: {
  storeName?: string;
  webdav?: {
    baseUrl: string;
    username?: string;
    password?: string;
  };
}): Promise<IFileSystem> {
  const { storeName = 'universal-sync-storage', webdav } = options || {};

  if (webdav && webdav.baseUrl) {
    // 使用 WebDAV
    return createWebDAVFileSystem({
      baseUrl: webdav.baseUrl,
      username: webdav.username,
      password: webdav.password,
    }) as any;
  } else {
    // 使用 IndexedDB
    await configure({
      mounts: {
        '/': {
          backend: IndexedDB,
          storeName,
        },
      },
    });

    return fs.promises as any;
  }
}

// 重新导出核心类型和类
export type { IFileSystem, SyncOptions } from './types.js';
export { SyncEngine } from './core/sync-engine.js';
export { sync } from './index.js';
export { saveDocumentToFs } from './core/file-saver.js';
