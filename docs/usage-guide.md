# 使用指南

## 快速开始

### 安装

```bash
npm install universal-sync-v2
```

### Node.js 环境

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';
import * as path from 'path';

// 创建 PouchDB 实例
const db = new PouchDB('mydb');

// 执行同步
await sync(db, fs, './storage');

console.log('同步完成！');
```

### 浏览器环境

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import { configure, fs } from '@zenfs/core';
import { WebDAV } from '@zenfs/webdav';

// 配置 WebDAV
await configure({
  mounts: {
    '/storage': {
      backend: WebDAV,
      url: 'https://your-webdav-server.com/path',
      username: 'your-username',
      password: 'your-password',
    }
  }
});

// 创建 PouchDB 实例
const db = new PouchDB('mydb');

// 执行同步
await sync(db, fs.promises, '/storage');

console.log('同步完成！');
```

## 完整示例

### 1. 基本同步

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

async function basicSync() {
  const db = new PouchDB('mydb');
  
  // 添加一些文档
  await db.put({ _id: 'user:1', name: 'Alice' });
  await db.put({ _id: 'user:2', name: 'Bob' });
  
  // 同步到文件
  await sync(db, fs, './storage');
  
  console.log('数据已同步到 ./storage');
}

basicSync().catch(console.error);
```

### 2. 自定义配置

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

async function customSync() {
  const db = new PouchDB('mydb');
  
  await sync(db, fs, './storage', {
    maxFileSize: 500 * 1024,        // 500KB per file
    maxFilesPerDirectory: 500,      // 500 files per directory
    mergeThreshold: 50 * 1024,      // Merge files smaller than 50KB
    mergeInterval: 120000,          // Check for merge every 2 minutes
    autoMerge: true,                // Enable auto merge
  });
  
  console.log('同步完成（自定义配置）');
}

customSync().catch(console.error);
```

### 3. 手动控制同步引擎

```typescript
import { SyncEngine } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

async function manualControl() {
  const db = new PouchDB('mydb');
  
  const engine = new SyncEngine(db, fs, {
    basePath: './storage',
    autoMerge: false,  // 禁用自动合并
  });
  
  try {
    // 初始化
    await engine.initialize();
    console.log('存储已初始化');
    
    // 执行同步
    await engine.sync();
    console.log('同步完成');
    
    // 手动触发合并
    await engine.performMerge();
    console.log('文件合并完成');
    
  } finally {
    // 清理资源
    await engine.cleanup();
  }
}

manualControl().catch(console.error);
```

### 4. 错误处理

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

async function syncWithRetry() {
  const db = new PouchDB('mydb');
  const maxRetries = 3;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      await sync(db, fs, './storage');
      console.log('同步成功');
      return;
    } catch (error) {
      attempt++;
      console.error(`同步失败 (尝试 ${attempt}/${maxRetries}):`, error.message);
      
      if (attempt < maxRetries) {
        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        throw error;
      }
    }
  }
}

syncWithRetry().catch(console.error);
```

### 5. 监控同步进度

```typescript
import { SyncEngine } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

async function monitorSync() {
  const db = new PouchDB('mydb');
  
  const engine = new SyncEngine(db, fs, {
    basePath: './storage',
    autoMerge: true,
  });
  
  // 包装原始方法以添加日志
  const originalSync = engine.sync.bind(engine);
  engine.sync = async function() {
    console.log('开始同步...');
    const start = Date.now();
    
    await originalSync();
    
    const duration = Date.now() - start;
    console.log(`同步完成，耗时 ${duration}ms`);
  };
  
  const originalMerge = engine.performMerge.bind(engine);
  engine.performMerge = async function() {
    console.log('开始合并文件...');
    const start = Date.now();
    
    await originalMerge();
    
    const duration = Date.now() - start;
    console.log(`文件合并完成，耗时 ${duration}ms`);
  };
  
  try {
    await engine.initialize();
    await engine.sync();
    
    // 保持运行以观察自动合并
    console.log('等待自动合并...');
    await new Promise(resolve => setTimeout(resolve, 300000)); // 5分钟
    
  } finally {
    await engine.cleanup();
  }
}

monitorSync().catch(console.error);
```

## 实际应用场景

### 场景 1: 离线优先的 Web 应用

```typescript
// app.ts
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import { configure, fs } from '@zenfs/core';
import { WebDAV } from '@zenfs/webdav';

class OfflineApp {
  private db: PouchDB.Database;
  private syncInterval?: number;
  
  async initialize(webdavUrl: string, credentials: { username: string; password: string }) {
    // 配置存储
    await configure({
      mounts: {
        '/storage': {
          backend: WebDAV,
          url: webdavUrl,
          ...credentials,
        }
      }
    });
    
    // 初始化数据库
    this.db = new PouchDB('app-data');
    
    // 首次同步
    await this.performSync();
    
    // 设置定期同步
    this.syncInterval = setInterval(() => {
      this.performSync().catch(console.error);
    }, 60000); // 每分钟同步一次
  }
  
  private async performSync() {
    try {
      console.log('正在同步...');
      await sync(this.db, fs.promises, '/storage', {
        autoMerge: true,
        mergeInterval: 300000, // 5分钟合并一次
      });
      console.log('同步完成');
    } catch (error) {
      console.error('同步失败:', error);
      // 离线时继续使用本地数据
    }
  }
  
  async getData(id: string) {
    try {
      return await this.db.get(id);
    } catch (error) {
      if (error.name === 'not_found') {
        return null;
      }
      throw error;
    }
  }
  
  async saveData(data: any) {
    await this.db.put(data);
    // 立即同步
    await this.performSync();
  }
  
  async cleanup() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
  }
}

// 使用
const app = new OfflineApp();
await app.initialize('https://your-webdav-server.com', {
  username: 'user',
  password: 'pass'
});

// 保存数据
await app.saveData({
  _id: 'note:1',
  title: 'My Note',
  content: 'Hello World',
});

// 读取数据
const note = await app.getData('note:1');
console.log(note);
```

### 场景 2: 多设备数据同步

```typescript
// sync-service.ts
import { sync, SyncEngine } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

class MultiDeviceSync {
  private db: PouchDB.Database;
  private engine?: SyncEngine;
  private storagePath: string;
  
  constructor(appName: string) {
    // 使用用户目录存储数据
    const userDataPath = path.join(os.homedir(), '.config', appName);
    this.storagePath = path.join(userDataPath, 'storage');
    
    // 初始化数据库
    const dbPath = path.join(userDataPath, 'db');
    this.db = new PouchDB(dbPath);
  }
  
  async start() {
    this.engine = new SyncEngine(this.db, fs, {
      basePath: this.storagePath,
      autoMerge: true,
      mergeInterval: 60000,
    });
    
    await this.engine.initialize();
    
    // 首次完整同步
    await this.engine.sync();
    console.log('初始同步完成');
    
    // 监听数据库变化
    this.db.changes({
      since: 'now',
      live: true,
      include_docs: true
    }).on('change', (change) => {
      console.log('数据变化:', change.id);
      // 延迟同步以批量处理
      this.scheduleSync();
    });
  }
  
  private syncTimer?: NodeJS.Timeout;
  private scheduleSync() {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    
    this.syncTimer = setTimeout(() => {
      this.engine?.sync().catch(console.error);
    }, 5000); // 5秒后同步
  }
  
  async stop() {
    if (this.engine) {
      await this.engine.cleanup();
    }
  }
}

// 使用
const syncService = new MultiDeviceSync('my-app');
await syncService.start();

// 应用程序退出时
process.on('SIGINT', async () => {
  await syncService.stop();
  process.exit(0);
});
```

### 场景 3: 数据备份工具

```typescript
// backup.ts
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';
import * as path from 'path';

async function backup(
  sourceDb: string,
  backupPath: string
) {
  console.log(`开始备份 ${sourceDb} 到 ${backupPath}`);
  
  // 打开源数据库
  const db = new PouchDB(sourceDb);
  
  // 创建带时间戳的备份目录
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupPath, `backup-${timestamp}`);
  
  // 执行同步（相当于备份）
  await sync(db, fs, backupDir, {
    autoMerge: false, // 备份不需要合并
  });
  
  console.log(`备份完成: ${backupDir}`);
  
  return backupDir;
}

async function restore(
  backupPath: string,
  targetDb: string
) {
  console.log(`从 ${backupPath} 恢复到 ${targetDb}`);
  
  // 打开目标数据库
  const db = new PouchDB(targetDb);
  
  // 从备份同步回数据库
  await sync(db, fs, backupPath);
  
  console.log('恢复完成');
}

// 使用
const backupDir = await backup('./mydb', './backups');
// await restore(backupDir, './restored-db');
```

## 调试技巧

### 启用详细日志

```typescript
import { SyncEngine } from 'universal-sync-v2';

// 覆盖控制台方法以添加时间戳
const originalLog = console.log;
console.log = (...args) => {
  const timestamp = new Date().toISOString();
  originalLog(`[${timestamp}]`, ...args);
};

// 使用同步引擎
const engine = new SyncEngine(db, fs, options);
await engine.sync();
```

### 检查存储结构

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';

async function inspectStorage(storagePath: string) {
  // 读取清单
  const manifestPath = path.join(storagePath, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  
  console.log('存储版本:', manifest.version);
  console.log('最后序列号:', manifest.lastSequence);
  console.log('文件数量:', manifest.files.length);
  
  // 列出数据文件
  const dataDir = path.join(storagePath, 'data');
  const dataFiles = await fs.readdir(dataDir);
  console.log('数据文件:', dataFiles.length);
  
  // 列出合并文件
  const mergedDir = path.join(storagePath, 'merged');
  try {
    const mergedFiles = await fs.readdir(mergedDir);
    console.log('合并文件:', mergedFiles.length);
  } catch {
    console.log('合并文件: 0');
  }
}

await inspectStorage('./storage');
```

## 性能优化

### 1. 批量操作

```typescript
// ❌ 不推荐：逐个添加文档
for (let i = 0; i < 1000; i++) {
  await db.put({ _id: `doc-${i}`, data: i });
  await sync(db, fs, './storage'); // 每次都同步
}

// ✅ 推荐：批量添加后同步一次
const docs = [];
for (let i = 0; i < 1000; i++) {
  docs.push({ _id: `doc-${i}`, data: i });
}
await db.bulkDocs(docs);
await sync(db, fs, './storage'); // 只同步一次
```

### 2. 合理的合并配置

```typescript
// 高频更新场景
await sync(db, fs, './storage', {
  maxFileSize: 500 * 1024,     // 较小的文件
  mergeThreshold: 50 * 1024,   // 积极合并
  mergeInterval: 30000,        // 频繁检查
});

// 低频更新场景
await sync(db, fs, './storage', {
  maxFileSize: 2 * 1024 * 1024,  // 较大的文件
  mergeThreshold: 200 * 1024,    // 保守合并
  mergeInterval: 600000,         // 不频繁检查
});
```

### 3. 增量同步

```typescript
let lastSyncTime = Date.now();

async function incrementalSync() {
  const changes = await db.changes({
    since: lastSyncTime,
    include_docs: true
  });
  
  if (changes.results.length > 0) {
    await sync(db, fs, './storage');
    lastSyncTime = Date.now();
  }
}

// 定期增量同步
setInterval(incrementalSync, 60000);
```

## 常见问题

### Q: 如何处理大量数据？

A: 使用合理的分片配置，并启用自动合并：

```typescript
await sync(db, fs, './storage', {
  maxFileSize: 1024 * 1024,      // 1MB per file
  maxFilesPerDirectory: 1000,    // 1000 files per dir
  autoMerge: true,
});
```

### Q: 如何在离线时继续工作？

A: PouchDB 本身支持离线工作，只需在网络恢复后重新同步：

```typescript
try {
  await sync(db, fs, './storage');
} catch (error) {
  console.log('离线模式，将在恢复后同步');
}
```

### Q: 如何清理旧数据？

A: 可以手动删除已归档的原始文件：

```typescript
import { ManifestManager } from 'universal-sync-v2';

const manifest = new ManifestManager(fs, './storage');
const content = await manifest.readManifest();

for (const file of content.files) {
  if (file.mergedFrom?.[0] === 'archived') {
    // 删除已归档的文件
    await fs.unlink(`./storage/data/${file.filename}`);
  }
}
```

## 下一步

- 阅读 [API 参考](./api.md) 了解详细的 API 文档
- 查看 [架构设计](./architecture.md) 了解内部实现
- 探索 [存储格式](./storage-format.md) 了解数据结构
- 学习 [文件合并](./file-merging.md) 了解优化机制
