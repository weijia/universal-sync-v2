# 浏览器测试说明

## 📦 如何在浏览器中使用本库

`test/index.html` 是一个完整的浏览器测试页面，它展示了如何在浏览器环境中使用 Universal Sync V2。

## 🔧 导入方式

### 当前的导入方式

```javascript
// 1. 导入依赖（从 CDN）
import { configure, fs } from 'https://cdn.jsdelivr.net/npm/@zenfs/core@0.17.0/dist/browser.min.mjs';
import { WebDAV } from 'https://cdn.jsdelivr.net/npm/@zenfs/webdav@0.1.0/dist/browser.min.mjs';
import PouchDB from 'https://cdn.jsdelivr.net/npm/pouchdb@8.0.1/+esm';

// 2. 导入本库（从本地构建文件）
import { sync } from '../dist/index.js';
```

### 为什么这样设计？

1. **依赖从 CDN 加载**：zen-fs 和 PouchDB 可以直接从 CDN 获取，无需本地构建
2. **本库从本地加载**：因为这是你正在开发的库，需要从构建后的文件导入

## 📝 使用步骤

### 步骤 1: 构建项目

这一步**非常重要**，必须先构建才能在浏览器中使用：

```bash
npm run build
```

构建后会生成：
```
dist/
├── index.js          # ES Module 格式，浏览器可用
├── index.d.ts        # TypeScript 类型定义
├── core/             # 核心模块
│   ├── lock-manager.js
│   ├── manifest-manager.js
│   ├── storage-manager.js
│   └── sync-engine.js
├── utils/            # 工具模块
│   ├── fs-utils.js
│   └── helpers.js
├── constants.js
└── types.js
```

### 步骤 2: 启动本地服务器

由于浏览器的安全限制（CORS），你需要通过 HTTP 服务器访问文件：

```bash
# 使用 http-server
npx http-server -p 3000

# 或者使用 Python
python -m http.server 3000

# 或者使用 Node.js
npx serve -p 3000
```

### 步骤 3: 准备 WebDAV 服务器

#### 方式 A: Docker（最简单）

```bash
docker run -d \
  -p 8080:80 \
  -e WEBDAV_USERNAME=test \
  -e WEBDAV_PASSWORD=test123 \
  bytemark/webdav
```

#### 方式 B: NextCloud/OwnCloud

如果你已有 NextCloud 或 OwnCloud：
1. 登录你的账号
2. 获取 WebDAV URL（通常是 `https://your-server.com/remote.php/dav/files/USERNAME/`）
3. 使用你的用户名和密码

### 步骤 4: 打开测试页面

在浏览器中访问：

```
http://localhost:3000/test/index.html
```

### 步骤 5: 配置和测试

1. **输入 WebDAV 配置**：
   - URL: `http://localhost:8080/`
   - 用户名: `test`
   - 密码: `test123`

2. **点击"连接 WebDAV"**

3. **添加一些测试数据**：
   - 点击"添加测试文档"
   - 或点击"添加多个文档"

4. **执行同步**：
   - 点击"执行同步"
   - 查看日志输出

5. **查看结果**：
   - 在 WebDAV 服务器中查看生成的文件
   - 点击"列出所有文档"查看数据

## 🔍 代码解析

### 同步功能的实现

```javascript
window.performSync = async function() {
    try {
        log('开始同步...', 'info');
        
        // 调用本库的 sync 函数
        await sync(window.db, window.fsInstance, '/storage', {
            maxFileSize: 500 * 1024,     // 500KB
            mergeThreshold: 50 * 1024,   // 50KB
            autoMerge: false,            // 手动控制合并
        });
        
        log('同步完成！', 'success');
        
    } catch (error) {
        log(`同步失败: ${error.message}`, 'error');
    }
};
```

### 文件合并功能的实现

```javascript
window.performMerge = async function() {
    try {
        // 动态导入 SyncEngine
        const { SyncEngine } = await import('../dist/index.js');
        
        // 创建引擎实例
        window.syncEngine = new SyncEngine(window.db, window.fsInstance, {
            basePath: '/storage',
            autoMerge: false,
        });
        
        await window.syncEngine.initialize();
        await window.syncEngine.performMerge();
        
        log('文件合并完成！', 'success');
        
    } catch (error) {
        log(`合并失败: ${error.message}`, 'error');
    }
};
```

## 📦 其他导入方式

### 方式 1: 从 CDN 导入（发布后）

如果你的库发布到了 npm，可以这样使用：

```html
<script type="module">
    import { sync } from 'https://cdn.jsdelivr.net/npm/universal-sync-v2/+esm';
    import PouchDB from 'https://cdn.jsdelivr.net/npm/pouchdb@8.0.1/+esm';
    import { configure, fs } from 'https://cdn.jsdelivr.net/npm/@zenfs/core@0.17.0/dist/browser.min.mjs';
    
    // 使用
    const db = new PouchDB('mydb');
    await sync(db, fs.promises, '/storage');
</script>
```

### 方式 2: 使用打包工具（Webpack/Vite）

如果你的项目使用打包工具：

```javascript
// 安装
// npm install universal-sync-v2 pouchdb @zenfs/core @zenfs/webdav

import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import { configure, fs } from '@zenfs/core';
import { WebDAV } from '@zenfs/webdav';

// 配置
await configure({
  mounts: {
    '/storage': { backend: WebDAV, url: '...' }
  }
});

// 使用
const db = new PouchDB('mydb');
await sync(db, fs.promises, '/storage');
```

### 方式 3: 使用 importmap（现代浏览器）

```html
<script type="importmap">
{
  "imports": {
    "universal-sync-v2": "./dist/index.js",
    "pouchdb": "https://cdn.jsdelivr.net/npm/pouchdb@8.0.1/+esm",
    "@zenfs/core": "https://cdn.jsdelivr.net/npm/@zenfs/core@0.17.0/dist/browser.min.mjs"
  }
}
</script>

<script type="module">
    import { sync } from 'universal-sync-v2';
    import PouchDB from 'pouchdb';
    import { fs } from '@zenfs/core';
    
    const db = new PouchDB('mydb');
    await sync(db, fs.promises, '/storage');
</script>
```

## 🐛 常见问题

### 问题 1: "Failed to resolve module specifier"

**错误信息**：
```
Failed to resolve module specifier '../dist/index.js'
```

**原因**：没有构建项目

**解决**：
```bash
npm run build
```

### 问题 2: CORS 错误

**错误信息**：
```
Access to script at 'file:///.../dist/index.js' from origin 'null' 
has been blocked by CORS policy
```

**原因**：直接用 `file://` 协议打开 HTML 文件

**解决**：使用 HTTP 服务器：
```bash
npx http-server -p 3000
```

### 问题 3: "Cannot find module"

**错误信息**：
```
Cannot find module '@zenfs/core'
```

**原因**：依赖没有正确加载

**解决**：
1. 检查网络连接
2. 确保 CDN URL 正确
3. 尝试使用其他 CDN（如 unpkg.com）

### 问题 4: WebDAV 连接失败

**可能的原因**：
1. WebDAV 服务器没有启动
2. URL 不正确
3. 用户名/密码错误
4. CORS 问题

**解决**：
1. 确认 WebDAV 服务器正在运行
2. 检查 URL（注意末尾的 `/`）
3. 验证凭据
4. 配置 WebDAV 服务器允许 CORS

## 📊 实际文件结构

同步后，在 WebDAV 服务器上会看到：

```
/storage/
├── manifest.json              # 清单文件
├── data/                      # 数据目录
│   ├── data-1-2024-10-31T...json
│   ├── data-2-2024-10-31T...json
│   └── ...
└── merged/                    # 合并文件（执行合并后）
    └── merged-1-5-2024-10-31T...json
```

## 🎯 测试清单

使用这个清单确保所有功能正常：

- [ ] 构建项目 (`npm run build`)
- [ ] 启动本地服务器
- [ ] 启动 WebDAV 服务器
- [ ] 打开测试页面
- [ ] 连接 WebDAV 成功
- [ ] 添加测试文档成功
- [ ] 执行同步成功
- [ ] 在 WebDAV 中看到文件
- [ ] 列出文档能看到数据
- [ ] 手动合并成功
- [ ] 查看合并后的文件

## 🚀 生产环境使用

在生产环境中，你应该：

1. **使用 CDN**：将库发布到 npm，然后从 CDN 加载
2. **使用打包工具**：用 Webpack、Vite 等打包你的应用
3. **配置 HTTPS**：使用安全连接
4. **配置 CORS**：正确配置 WebDAV 服务器的 CORS 策略
5. **错误处理**：添加完善的错误处理和用户提示

## 📚 相关文档

- [使用指南](../docs/usage-guide.md) - 详细的使用说明
- [API 参考](../docs/api.md) - 完整的 API 文档
- [快速启动](../QUICKSTART.md) - 快速开始指南
