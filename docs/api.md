# API 参考

## 主接口

### sync()

主同步函数，这是库的唯一公开接口。

```typescript
async function sync(
  db: PouchDB.Database,
  fs: IFileSystem,
  basePath: string,
  options?: Partial<SyncOptions>
): Promise<void>
```

**参数：**

- `db`: PouchDB 数据库实例
- `fs`: 文件系统实例（兼容 Node.js fs 接口）
- `basePath`: 存储根目录的路径
- `options`: 可选的同步选项

**返回值：**

- `Promise<void>`: 同步完成后 resolve

**示例：**

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

const db = new PouchDB('mydb');
await sync(db, fs, '/path/to/storage', {
  maxFileSize: 1024 * 1024,  // 1MB
  autoMerge: true,
});
```

**异常：**

- 如果文件系统操作失败，会抛出相应错误
- 如果 PouchDB 操作失败，会抛出相应错误
- 如果锁获取超时，会抛出超时错误

---

## 类型定义

### IFileSystem

文件系统接口，需要实现以下方法：

```typescript
interface IFileSystem {
  readFile(path: string, encoding: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    mtime: Date;
  }>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
```

**Node.js 实现：**

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';

const nodeFS: IFileSystem = {
  readFile: (p, enc) => fs.readFile(p, enc),
  writeFile: (p, data) => fs.writeFile(p, data),
  readdir: (p) => fs.readdir(p),
  mkdir: (p, opts) => fs.mkdir(p, opts),
  stat: async (p) => {
    const stats = await fs.stat(p);
    return {
      isFile: () => stats.isFile(),
      isDirectory: () => stats.isDirectory(),
      mtime: stats.mtime,
    };
  },
  unlink: (p) => fs.unlink(p),
  rename: (oldP, newP) => fs.rename(oldP, newP),
  exists: async (p) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
};
```

### SyncOptions

同步配置选项：

```typescript
interface SyncOptions {
  basePath: string;              // 必需：存储根路径
  maxFileSize?: number;          // 可选：单个文件最大大小（字节）
  maxFilesPerDirectory?: number; // 可选：每个目录最大文件数
  mergeThreshold?: number;       // 可选：文件合并阈值（字节）
  mergeInterval?: number;        // 可选：自动合并间隔（毫秒）
  autoMerge?: boolean;           // 可选：是否启用自动合并
}
```

**默认值：**

```typescript
{
  maxFileSize: 1024 * 1024,      // 1MB
  maxFilesPerDirectory: 1000,
  mergeThreshold: 100 * 1024,    // 100KB
  mergeInterval: 60000,          // 60秒
  autoMerge: true,
}
```

### StoredDocument

存储的文档类型：

```typescript
interface StoredDocument {
  _id: string;        // 文档 ID
  _rev: string;       // 版本号
  _deleted?: boolean; // 是否已删除
  [key: string]: any; // 其他字段
}
```

### DataFileMetadata

数据文件元数据：

```typescript
interface DataFileMetadata {
  filename: string;         // 文件名
  startSeq: number;         // 起始序列号
  endSeq: number;           // 结束序列号
  timestamp: number;        // 时间戳
  documentCount: number;    // 文档数量
  mergedFrom?: string[];    // 如果是合并文件，记录源文件
}
```

### ManifestContent

清单文件内容：

```typescript
interface ManifestContent {
  version: string;           // 存储格式版本
  lastSequence: number;      // 最后的序列号
  lastTimestamp: number;     // 最后更新时间戳
  files: DataFileMetadata[]; // 所有数据文件元数据
}
```

---

## 高级 API（可选使用）

如果需要更细粒度的控制，可以直接使用内部类：

### SyncEngine

```typescript
import { SyncEngine } from 'universal-sync-v2';

const engine = new SyncEngine(db, fs, options);
await engine.initialize();
await engine.sync();
await engine.performMerge();
engine.stopAutoMerge();
await engine.cleanup();
```

**方法：**

- `initialize()`: 初始化存储结构
- `sync()`: 执行完整同步
- `performMerge()`: 手动触发文件合并
- `stopAutoMerge()`: 停止自动合并
- `cleanup()`: 清理资源

### StorageManager

```typescript
import { StorageManager } from 'universal-sync-v2';

const storage = new StorageManager(fs, options);
await storage.initialize();
await storage.writeDocuments(docs);
const allDocs = await storage.readAllDocuments();
const incrementalDocs = await storage.readIncrementalDocuments(fromSeq);
const candidates = await storage.getMergeCandidates();
await storage.mergeFiles(files);
```

**方法：**

- `initialize()`: 初始化存储
- `writeDocuments(docs)`: 写入文档
- `readAllDocuments()`: 读取所有文档
- `readIncrementalDocuments(fromSeq)`: 增量读取
- `getMergeCandidates()`: 获取可合并文件组
- `mergeFiles(files)`: 合并文件

### ManifestManager

```typescript
import { ManifestManager } from 'universal-sync-v2';

const manifest = new ManifestManager(fs, basePath);
const content = await manifest.readManifest();
await manifest.addFile(metadata);
await manifest.updateFile(filename, updates);
const files = await manifest.getFiles();
const lastSeq = await manifest.getLastSequence();
const candidates = await manifest.getMergeCandidates(threshold);
```

**方法：**

- `readManifest()`: 读取清单
- `addFile(metadata)`: 添加文件元数据
- `updateFile(filename, updates)`: 更新文件元数据
- `getFiles()`: 获取所有文件列表
- `getLastSequence()`: 获取最后序列号
- `getMergeCandidates(threshold)`: 获取合并候选

### LockManager

```typescript
import { LockManager } from 'universal-sync-v2';

const lockManager = new LockManager(fs, basePath);
const lockId = await lockManager.acquireLock('lockName', 'operation');
await lockManager.releaseLock('lockName', lockId);

// 或使用 withLock 自动管理
await lockManager.withLock('lockName', 'operation', async () => {
  // 在锁保护下执行操作
});
```

**方法：**

- `acquireLock(name, operation)`: 获取锁
- `releaseLock(name, lockId)`: 释放锁
- `withLock(name, operation, fn)`: 在锁保护下执行函数

---

## 错误处理

### 常见错误

1. **文件系统错误**
   ```typescript
   try {
     await sync(db, fs, '/path/to/storage');
   } catch (error) {
     if (error.code === 'ENOENT') {
       console.error('目录不存在');
     } else if (error.code === 'EACCES') {
       console.error('权限不足');
     }
   }
   ```

2. **锁超时错误**
   ```typescript
   try {
     await sync(db, fs, '/path/to/storage');
   } catch (error) {
     if (error.message.includes('Failed to acquire lock')) {
       console.error('获取锁超时，可能有其他进程正在同步');
     }
   }
   ```

3. **PouchDB 错误**
   ```typescript
   try {
     await sync(db, fs, '/path/to/storage');
   } catch (error) {
     if (error.name === 'conflict') {
       console.error('文档冲突');
     }
   }
   ```

### 最佳实践

1. **始终处理错误**
   ```typescript
   try {
     await sync(db, fs, basePath);
   } catch (error) {
     console.error('同步失败:', error);
     // 实现重试逻辑或通知用户
   }
   ```

2. **使用合适的配置**
   ```typescript
   await sync(db, fs, basePath, {
     maxFileSize: 500 * 1024,  // 较小的文件便于网络传输
     autoMerge: true,          // 自动维护存储
     mergeInterval: 120000,    // 2分钟合并一次
   });
   ```

3. **定期清理**
   ```typescript
   const engine = new SyncEngine(db, fs, options);
   try {
     await engine.sync();
   } finally {
     await engine.cleanup();  // 释放资源
   }
   ```

---

## 环境兼容性

### Node.js

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

const db = new PouchDB('mydb');
await sync(db, fs, './storage');
```

### 浏览器 + zen-fs

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import { configure, fs } from '@zenfs/core';
import { WebDAV } from '@zenfs/webdav';

await configure({
  mounts: {
    '/storage': WebDAV,
  },
});

const db = new PouchDB('mydb');
await sync(db, fs.promises, '/storage');
```

### 浏览器 + BrowserFS

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as BrowserFS from 'browserfs';

BrowserFS.configure({
  fs: 'IndexedDB',
  options: {},
}, (err) => {
  if (err) throw err;
  
  const fs = BrowserFS.BFSRequire('fs').promises;
  const db = new PouchDB('mydb');
  
  sync(db, fs, '/storage');
});
```
