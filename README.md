# Universal Sync V2

一个通用的 PouchDB 同步库，支持 JSON 文件存储，可在 Node.js 和浏览器环境中运行。

## ✨ 特性

- ✅ **跨平台**：同时支持 Node.js 和浏览器环境
- ✅ **版本控制**：自动区分数据版本，防止新数据被旧数据覆盖
- ✅ **PouchDB 集成**：自动与 PouchDB 双向同步
- ✅ **智能分片**：自动分片，单个文件大小可控，便于下载
- ✅ **增量同步**：支持从最新数据开始同步，确保始终获取最新内容
- ✅ **自动合并**：智能合并小文件，优化存储和网络性能
- ✅ **并发安全**：支持多用户同时访问，使用分布式锁防止冲突
- ✅ **简单易用**：只需一个 `sync()` 接口，自动处理所有复杂逻辑
- ✅ **不删除文件**：保留所有历史数据，合并后原文件仍可用作备份

## 📦 安装

```bash
npm install universal-sync-v2
```

## 🚀 快速开始

### Node.js 环境

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

// 创建 PouchDB 实例
const db = new PouchDB('mydb');

// 添加一些数据
await db.put({ _id: 'user:1', name: 'Alice' });
await db.put({ _id: 'user:2', name: 'Bob' });

// 同步到文件系统
await sync(db, fs, './storage');

console.log('同步完成！');
```

### 浏览器环境（使用 zen-fs-webdav）

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

// 同步到 WebDAV
await sync(db, fs.promises, '/storage');

console.log('同步完成！');
```

## 📚 文档

完整文档请查看 [docs](./docs) 目录：

- **[快速开始](./QUICKSTART.md)** - 5 分钟快速上手指南
- **[文档索引](./docs/README.md)** - 文档导航和快速查找
- **[使用指南](./docs/usage-guide.md)** - 详细的使用说明和示例代码
- **[浏览器使用](./docs/browser-usage.md)** - 浏览器环境完整指南
- **[API 参考](./docs/api.md)** - 完整的 API 文档
- **[架构设计](./docs/architecture.md)** - 系统架构和核心模块
- **[存储格式](./docs/storage-format.md)** - 文件结构和数据格式
- **[文件合并](./docs/file-merging.md)** - 文件合并机制详解

## 🧪 测试

### 运行单元测试

```bash
npm test
```

### 浏览器测试

1. 构建项目：
```bash
npm run build
```

2. 启动 WebDAV 服务器（使用 Docker）：
```bash
docker run -d -p 8080:80 -e WEBDAV_USERNAME=test -e WEBDAV_PASSWORD=test123 bytemark/webdav
```

3. 启动本地服务器：
```bash
npx http-server -p 3000
```

4. 打开浏览器访问 http://localhost:3000/test/index.html

详细说明请查看 [浏览器测试文档](./test/README.md)。

## 🔧 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 运行测试
npm test

# 开发模式
npm run dev
```

## 许可证

MIT
