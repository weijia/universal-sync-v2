# Universal Sync V2 文档

欢迎来到 Universal Sync V2 的文档中心！

## 📚 文档索引

### 新手入门
- **[使用指南](./usage-guide.md)** - 快速开始、完整示例、实际应用场景
  - 快速开始（Node.js 和浏览器）
  - 完整代码示例
  - 实际应用场景（离线应用、多设备同步、数据备份）
  - 调试技巧和性能优化

### 核心概念
- **[架构设计](./architecture.md)** - 系统架构、核心模块、数据流
  - 系统架构图
  - 核心模块详解（SyncEngine、StorageManager、ManifestManager、LockManager）
  - 同步和并发控制流程
  - 性能优化策略

### API 文档
- **[API 参考](./api.md)** - 完整的 API 文档
  - 主接口 `sync()`
  - 类型定义（IFileSystem、SyncOptions 等）
  - 高级 API（SyncEngine、StorageManager 等）
  - 错误处理和环境兼容性

### 技术细节
- **[同步过程详解](./sync-process.md)** - PouchDB 与文件存储的同步机制
  - 同步架构和数据流
  - Pull/Push 阶段详解
  - 版本控制机制
  - 并发控制实现

- **[存储格式](./storage-format.md)** - 文件结构和数据格式
  - 目录结构
  - 清单文件格式
  - 数据文件格式
  - 版本控制和序列号分配
  - 故障恢复

- **[文件合并机制](./file-merging.md)** - 文件合并的详细说明
  - 合并策略和算法
  - 并发控制
  - 性能影响和优化
  - 配置选项

## 🎯 快速导航

### 我想...

#### 开始使用
👉 查看 [使用指南 - 快速开始](./usage-guide.md#快速开始)

#### 在 Node.js 中使用
👉 查看 [使用指南 - Node.js 环境](./usage-guide.md#nodejs-环境)

#### 在浏览器中使用
👉 查看 [使用指南 - 浏览器环境](./usage-guide.md#浏览器环境)

#### 了解系统如何工作
👉 查看 [架构设计](./architecture.md) 和 [同步过程详解](./sync-process.md)

#### 查找具体的 API
👉 查看 [API 参考](./api.md)

#### 了解存储格式
👉 查看 [存储格式](./storage-format.md)

#### 优化性能
👉 查看 [文件合并机制](./file-merging.md) 和 [使用指南 - 性能优化](./usage-guide.md#性能优化)

#### 处理错误
👉 查看 [API 参考 - 错误处理](./api.md#错误处理)

#### 自定义配置
👉 查看 [API 参考 - SyncOptions](./api.md#syncoptions)

## 📖 推荐阅读顺序

### 初学者
1. [使用指南 - 快速开始](./usage-guide.md#快速开始)
2. [API 参考 - 主接口](./api.md#主接口)
3. [使用指南 - 完整示例](./usage-guide.md#完整示例)

### 进阶用户
1. [架构设计](./architecture.md)
2. [同步过程详解](./sync-process.md)
3. [存储格式](./storage-format.md)
4. [文件合并机制](./file-merging.md)
5. [API 参考 - 高级 API](./api.md#高级-api可选使用)

### 问题排查
1. [使用指南 - 调试技巧](./usage-guide.md#调试技巧)
2. [使用指南 - 常见问题](./usage-guide.md#常见问题)
3. [API 参考 - 错误处理](./api.md#错误处理)

## 🔧 示例代码

### 最简单的使用方式

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

const db = new PouchDB('mydb');
await sync(db, fs, './storage');
```

### 带配置的使用

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

const db = new PouchDB('mydb');
await sync(db, fs, './storage', {
  maxFileSize: 500 * 1024,     // 500KB
  mergeThreshold: 50 * 1024,   // 50KB
  autoMerge: true,             // 自动合并
});
```

### 浏览器中使用

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import { configure, fs } from '@zenfs/core';
import { WebDAV } from '@zenfs/webdav';

await configure({
  mounts: {
    '/storage': {
      backend: WebDAV,
      url: 'https://your-webdav-server.com/path',
    }
  }
});

const db = new PouchDB('mydb');
await sync(db, fs.promises, '/storage');
```

## 🎨 核心特性

### ✅ 跨平台支持
同时支持 Node.js 和浏览器环境，通过统一的文件系统接口实现代码最大化重用。

### ✅ 版本控制
自动区分数据版本，确保新数据不会被旧数据覆盖，提供可靠的冲突解决机制。

### ✅ 智能分片
自动将数据分片到合理大小的文件中，优化下载和处理性能。

### ✅ 自动合并
智能合并小文件，减少文件数量和 HTTP 请求，提高读取性能。

### ✅ 并发安全
支持多用户同时访问，使用分布式锁防止竞争条件。

### ✅ 增量同步
支持从最新数据开始同步，只传输变化的数据，提高效率。

### ✅ 简单易用
只需一个 `sync()` 接口，自动处理所有复杂的同步和合并逻辑。

## 📦 相关资源

- **GitHub**: [universal-sync-v2](https://github.com/your-repo/universal-sync-v2)
- **npm**: [universal-sync-v2](https://www.npmjs.com/package/universal-sync-v2)
- **PouchDB**: [https://pouchdb.com/](https://pouchdb.com/)
- **zen-fs**: [https://github.com/zen-fs](https://github.com/zen-fs)

## 🤝 贡献

欢迎贡献代码、报告问题或提出改进建议！

## 📄 许可证

MIT License

---

**提示**: 如果您在使用过程中遇到问题，请先查看 [常见问题](./usage-guide.md#常见问题) 部分。如果问题仍未解决，欢迎在 GitHub 上提交 Issue。
