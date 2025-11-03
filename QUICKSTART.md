# 快速启动指南

## 🚀 立即开始使用

### 第一步：安装依赖

```bash
npm install
```

### 第二步：构建项目

```bash
npm run build
```

### 第三步：运行测试

```bash
npm test
```

## 📝 开发流程

### 开发模式（自动重新编译）

```bash
npm run dev
```

在另一个终端运行测试：

```bash
npm run test:watch
```

### 清理构建文件

```bash
npm run clean
```

## 🌐 浏览器测试

### 前置要求

在使用浏览器测试之前，你需要：

1. **构建项目**（重要！）：
   ```bash
   npm run build
   ```
   
   这会在 `dist/` 目录生成浏览器可用的 JavaScript 文件。

### 1. 准备 WebDAV 服务器

你需要一个 WebDAV 服务器用于测试。可以使用：

#### 选项 A: Docker 快速启动 WebDAV

```bash
docker run -d \
  -p 8080:80 \
  -e WEBDAV_USERNAME=test \
  -e WEBDAV_PASSWORD=test123 \
  bytemark/webdav
```

#### 选项 B: 使用 NextCloud/OwnCloud

如果你已有 NextCloud 或 OwnCloud，可以直接使用其 WebDAV 接口。

### 2. 启动测试服务器

```bash
npx http-server -p 3000
```

### 3. 打开测试页面

在浏览器中访问：

```
http://localhost:3000/test/index.html
```

### 4. 配置连接

在页面中输入你的 WebDAV 配置：
- URL: `http://localhost:8080/`
- 用户名: `test`
- 密码: `test123`

### 5. 开始测试

点击"连接 WebDAV"按钮，然后就可以测试各种功能了！

## 📚 快速参考

### 基本使用

```typescript
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

const db = new PouchDB('mydb');
await sync(db, fs, './storage');
```

### 自定义配置

```typescript
await sync(db, fs, './storage', {
  maxFileSize: 500 * 1024,        // 500KB
  mergeThreshold: 50 * 1024,      // 50KB
  mergeInterval: 60000,           // 60秒
  autoMerge: true,                // 自动合并
});
```

### 手动控制

```typescript
import { SyncEngine } from 'universal-sync-v2';

const engine = new SyncEngine(db, fs, options);
await engine.initialize();
await engine.sync();
await engine.performMerge();
await engine.cleanup();
```

## 🔍 检查构建输出

构建后的文件在 `dist/` 目录：

```
dist/
├── index.js          # 主入口
├── index.d.ts        # TypeScript 类型定义
├── core/             # 核心模块
├── utils/            # 工具函数
└── ...
```

## 🧪 测试覆盖率

查看测试覆盖率：

```bash
npm test -- --coverage
```

## 📖 下一步

- 阅读 [使用指南](./docs/usage-guide.md)
- 查看 [API 参考](./docs/api.md)
- 了解 [架构设计](./docs/architecture.md)

## ❓ 遇到问题？

1. 检查是否安装了所有依赖
2. 确保 TypeScript 版本兼容
3. 查看 [常见问题](./docs/usage-guide.md#常见问题)
4. 查看构建错误日志

## 🎉 开始你的第一个项目

创建一个新文件 `example.ts`：

```typescript
import { sync } from './dist/index.js';
import PouchDB from 'pouchdb';
import * as fs from 'fs/promises';

async function main() {
  // 创建数据库
  const db = new PouchDB('test-db');
  
  // 添加一些数据
  await db.put({
    _id: 'user:1',
    name: 'Alice',
    email: 'alice@example.com'
  });
  
  // 同步到文件
  await sync(db, fs, './test-storage');
  
  console.log('✅ 同步完成！');
  console.log('📁 查看 ./test-storage 目录');
}

main().catch(console.error);
```

运行：

```bash
node example.ts
```

查看生成的文件：

```bash
ls -R test-storage/
```

你会看到：
- `manifest.json` - 清单文件
- `data/` - 数据文件目录
- `data/data-1-*.json` - 你的数据

## 🎓 学习路径

1. **初级**: 运行示例，理解基本用法
2. **中级**: 阅读架构文档，理解内部机制
3. **高级**: 查看源代码，自定义扩展

祝你使用愉快！🚀
