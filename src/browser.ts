/**
 * 浏览器辅助模块
 * 提供简化的浏览器配置功能
 */

export interface BrowserSyncOptions {
  /** PouchDB 数据库实例 */
  db: any;
  /** 存储根路径，默认为 '/storage' */
  basePath?: string;
  /** WebDAV 配置（可选） */
  webdav?: {
    url: string;
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
 * 自动配置 ZenFS 文件系统（支持 WebDAV 或 IndexedDB 后端）
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
 *     url: 'https://webdav.example.com',
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

  let fs: any;

  if (webdav && webdav.url) {
    // 使用 WebDAV - 使用工厂函数创建实例
    const { createWebDAVFileSystem } = await import('zen-fs-webdav');
    fs = createWebDAVFileSystem({
      baseUrl: webdav.url,
      username: webdav.username,
      password: webdav.password,
    });
  } else {
    // 使用 IndexedDB - 需要包装 ZenFS
    const { configure, fs: zenfs } = await import('@zenfs/core');
    const { IndexedDB } = await import('@zenfs/dom');
    
    await configure({
      mounts: {
        '/': {
          backend: IndexedDB,
          storeName,
        },
      },
    });

    fs = zenfs.promises;
  }

  // 导入并使用 sync 函数
  const { sync } = await import('./index.js');
  
  await sync(db, fs, basePath, {
    autoMerge,
  });
}

/**
 * 创建一个配置好的文件系统实例
 * 用于需要手动控制同步流程的场景
 * 
 * @example
 * ```typescript
 * import { createBrowserFS, SyncEngine } from 'universal-sync-v2';
 * import PouchDB from 'pouchdb';
 * 
 * const db = new PouchDB('mydb');
 * const fs = await createBrowserFS({
 *   webdav: {
 *     url: 'https://webdav.example.com',
 *     username: 'user',
 *     password: 'pass'
 *   }
 * });
 * 
 * const engine = new SyncEngine(db, fs, { basePath: '/storage' });
 * await engine.initialize();
 * await engine.sync();
 * ```
 */
export async function createBrowserFS(options?: {
  webdav?: {
    url: string;
    username?: string;
    password?: string;
  };
  storeName?: string;
}): Promise<any> {
  const { 
    webdav,
    storeName = 'universal-sync-storage'
  } = options || {};

  if (webdav && webdav.url) {
    // 使用 WebDAV - 使用工厂函数
    const { createWebDAVFileSystem } = await import('zen-fs-webdav');
    return createWebDAVFileSystem({
      baseUrl: webdav.url,
      username: webdav.username,
      password: webdav.password,
    });
  } else {
    // 使用 IndexedDB - 包装 ZenFS
    const { configure, fs } = await import('@zenfs/core');
    const { IndexedDB } = await import('@zenfs/dom');
    
    await configure({
      mounts: {
        '/': {
          backend: IndexedDB,
          storeName,
        },
      },
    });

    return fs.promises;
  }
}
