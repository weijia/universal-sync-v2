# 浏览器环境使用指南

本文档详细说明如何在浏览器环境中使用 Universal Sync V2。

## 📋 目录

- [快速开始](#快速开始)
- [导入方式](#导入方式)
- [配置文件系统](#配置文件系统)
- [基本使用](#基本使用)
- [完整示例](#完整示例)
- [最佳实践](#最佳实践)
- [故障排除](#故障排除)

## 🚀 快速开始

### 最小示例

```html
<!DOCTYPE html>
<html>
<head>
    <title>Universal Sync 示例</title>
</head>
<body>
    <button onclick="testSync()">测试同步</button>
    <div id="output"></div>

    <script type="module">
        // 1. 导入依赖
        import { sync } from 'https://cdn.jsdelivr.net/npm/universal-sync-v2/+esm';
        import PouchDB from 'https://cdn.jsdelivr.net/npm/pouchdb@8.0.1/+esm';
        import { configure, fs } from 'https://cdn.jsdelivr.net/npm/@zenfs/core@0.17.0/dist/browser.min.mjs';
        import { WebDAV } from 'https://cdn.jsdelivr.net/npm/@zenfs/webdav@0.1.0/dist/browser.min.mjs';

        // 2. 配置 WebDAV
        await configure({
            mounts: {
                '/storage': {
                    backend: WebDAV,
                    url: 'http://localhost:8080/',
                    username: 'test',
                    password: 'test123'
                }
            }
        });

        // 3. 创建数据库
        const db = new PouchDB('myapp');

        // 4. 测试函数
        window.testSync = async function() {
            try {
                // 添加一些数据
                await db.put({
                    _id: 'doc1',
                    title: 'Hello',
                    content: 'World'
                });

                // 执行同步
                await sync(db, fs.promises, '/storage');
                
                document.getElementById('output').textContent = '同步成功！';
            } catch (error) {
                document.getElementById('output').textContent = '错误: ' + error.message;
            }
        };
    </script>
</body>
</html>
```

## 📦 导入方式

### 方式 1: 从 CDN 导入（推荐用于原型和小项目）

```javascript
import { sync } from 'https://cdn.jsdelivr.net/npm/universal-sync-v2/+esm';
```

**优点**：
- 无需构建步骤
- 快速原型开发
- 自动缓存

**缺点**：
- 需要网络连接
- 可能有延迟

### 方式 2: 使用打包工具（推荐用于生产环境）

```bash
npm install universal-sync-v2 pouchdb @zenfs/core @zenfs/webdav
```

```javascript
// Webpack、Vite、Rollup 等
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import { configure, fs } from '@zenfs/core';
import { WebDAV } from '@zenfs/webdav';
```

**优点**：
- 离线可用
- 更好的性能
- 代码优化
- Tree shaking

**缺点**：
- 需要构建步骤
- 更复杂的配置

### 方式 3: Import Maps（现代浏览器）

```html
<script type="importmap">
{
  "imports": {
    "universal-sync-v2": "https://cdn.jsdelivr.net/npm/universal-sync-v2/+esm",
    "pouchdb": "https://cdn.jsdelivr.net/npm/pouchdb@8.0.1/+esm",
    "@zenfs/core": "https://cdn.jsdelivr.net/npm/@zenfs/core@0.17.0/dist/browser.min.mjs",
    "@zenfs/webdav": "https://cdn.jsdelivr.net/npm/@zenfs/webdav@0.1.0/dist/browser.min.mjs"
  }
}
</script>

<script type="module">
    import { sync } from 'universal-sync-v2';
    import PouchDB from 'pouchdb';
    // ... 使用
</script>
```

**优点**：
- 清晰的依赖管理
- 易于更新版本
- 无需构建工具

**缺点**：
- 浏览器兼容性（需要较新的浏览器）

## 🔧 配置文件系统

### WebDAV 配置

```javascript
import { configure } from '@zenfs/core';
import { WebDAV } from '@zenfs/webdav';

await configure({
    mounts: {
        '/storage': {
            backend: WebDAV,
            url: 'https://your-webdav-server.com/remote.php/dav/files/username/',
            username: 'your-username',
            password: 'your-password'
        }
    }
});
```

### 多个挂载点

```javascript
await configure({
    mounts: {
        '/personal': {
            backend: WebDAV,
            url: 'https://personal-cloud.com/dav/',
            username: 'user1',
            password: 'pass1'
        },
        '/work': {
            backend: WebDAV,
            url: 'https://work-server.com/webdav/',
            username: 'user2',
            password: 'pass2'
        }
    }
});
```

### IndexedDB 文件系统（用于本地测试）

```javascript
import { IndexedDB } from '@zenfs/dom';

await configure({
    mounts: {
        '/storage': {
            backend: IndexedDB,
            storeName: 'myapp-storage'
        }
    }
});
```

## 💡 基本使用

### 创建数据库

```javascript
import PouchDB from 'pouchdb';

// 创建或打开数据库
const db = new PouchDB('myapp');

// 添加数据
await db.put({
    _id: 'doc1',
    title: 'My First Document',
    content: 'Hello, World!'
});
```

### 执行同步

```javascript
import { sync } from 'universal-sync-v2';
import { fs } from '@zenfs/core';

// 基本同步
await sync(db, fs.promises, '/storage');

// 带选项的同步
await sync(db, fs.promises, '/storage', {
    maxFileSize: 500 * 1024,    // 500 KB
    mergeThreshold: 50 * 1024,  // 50 KB
    autoMerge: true,            // 自动合并
    chunkSize: 100              // 每个文件 100 个文档
});
```

### 手动控制

```javascript
import { SyncEngine } from 'universal-sync-v2';

// 创建引擎实例
const engine = new SyncEngine(db, fs.promises, {
    basePath: '/storage',
    maxFileSize: 500 * 1024,
    autoMerge: false
});

// 初始化
await engine.initialize();

// 执行同步
await engine.sync();

// 手动合并文件
await engine.performMerge();
```

## 🎯 完整示例

### 单页应用 (SPA)

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>笔记应用</title>
    <style>
        body { font-family: sans-serif; margin: 20px; }
        .note { border: 1px solid #ccc; padding: 10px; margin: 10px 0; }
        button { margin: 5px; padding: 10px; }
        #status { color: green; }
        .error { color: red; }
    </style>
</head>
<body>
    <h1>📝 笔记应用</h1>
    
    <div id="status"></div>
    
    <div>
        <h3>添加笔记</h3>
        <input type="text" id="title" placeholder="标题">
        <textarea id="content" placeholder="内容"></textarea>
        <button onclick="app.addNote()">添加</button>
    </div>
    
    <div>
        <h3>操作</h3>
        <button onclick="app.sync()">同步到云端</button>
        <button onclick="app.loadNotes()">刷新列表</button>
    </div>
    
    <div id="notes"></div>

    <script type="module">
        import { sync } from 'https://cdn.jsdelivr.net/npm/universal-sync-v2/+esm';
        import PouchDB from 'https://cdn.jsdelivr.net/npm/pouchdb@8.0.1/+esm';
        import { configure, fs } from 'https://cdn.jsdelivr.net/npm/@zenfs/core@0.17.0/dist/browser.min.mjs';
        import { WebDAV } from 'https://cdn.jsdelivr.net/npm/@zenfs/webdav@0.1.0/dist/browser.min.mjs';

        class NoteApp {
            constructor() {
                this.db = null;
                this.fs = null;
            }

            async initialize() {
                try {
                    // 配置 WebDAV
                    await configure({
                        mounts: {
                            '/storage': {
                                backend: WebDAV,
                                url: 'http://localhost:8080/',
                                username: 'test',
                                password: 'test123'
                            }
                        }
                    });

                    // 创建数据库
                    this.db = new PouchDB('notes');
                    this.fs = fs.promises;

                    this.showStatus('已连接');
                    await this.loadNotes();
                } catch (error) {
                    this.showStatus('初始化失败: ' + error.message, true);
                }
            }

            async addNote() {
                try {
                    const title = document.getElementById('title').value;
                    const content = document.getElementById('content').value;

                    if (!title || !content) {
                        alert('请填写标题和内容');
                        return;
                    }

                    await this.db.put({
                        _id: 'note_' + Date.now(),
                        type: 'note',
                        title,
                        content,
                        createdAt: new Date().toISOString()
                    });

                    document.getElementById('title').value = '';
                    document.getElementById('content').value = '';

                    this.showStatus('笔记已添加');
                    await this.loadNotes();
                } catch (error) {
                    this.showStatus('添加失败: ' + error.message, true);
                }
            }

            async loadNotes() {
                try {
                    const result = await this.db.allDocs({
                        include_docs: true,
                        startkey: 'note_',
                        endkey: 'note_\ufff0'
                    });

                    const notesDiv = document.getElementById('notes');
                    notesDiv.innerHTML = '<h3>我的笔记 (' + result.rows.length + ')</h3>';

                    result.rows.forEach(row => {
                        const note = row.doc;
                        const noteDiv = document.createElement('div');
                        noteDiv.className = 'note';
                        noteDiv.innerHTML = `
                            <h4>${note.title}</h4>
                            <p>${note.content}</p>
                            <small>${new Date(note.createdAt).toLocaleString()}</small>
                            <button onclick="app.deleteNote('${note._id}', '${note._rev}')">删除</button>
                        `;
                        notesDiv.appendChild(noteDiv);
                    });
                } catch (error) {
                    this.showStatus('加载失败: ' + error.message, true);
                }
            }

            async deleteNote(id, rev) {
                try {
                    await this.db.remove(id, rev);
                    this.showStatus('笔记已删除');
                    await this.loadNotes();
                } catch (error) {
                    this.showStatus('删除失败: ' + error.message, true);
                }
            }

            async sync() {
                try {
                    this.showStatus('正在同步...');
                    
                    await sync(this.db, this.fs, '/storage', {
                        maxFileSize: 500 * 1024,
                        autoMerge: true
                    });
                    
                    this.showStatus('同步完成！');
                } catch (error) {
                    this.showStatus('同步失败: ' + error.message, true);
                }
            }

            showStatus(message, isError = false) {
                const status = document.getElementById('status');
                status.textContent = message;
                status.className = isError ? 'error' : '';
            }
        }

        // 创建全局应用实例
        window.app = new NoteApp();
        
        // 初始化
        window.addEventListener('DOMContentLoaded', () => {
            app.initialize();
        });
    </script>
</body>
</html>
```

### React 应用

```jsx
import React, { useState, useEffect } from 'react';
import { sync } from 'universal-sync-v2';
import PouchDB from 'pouchdb';
import { configure, fs } from '@zenfs/core';
import { WebDAV } from '@zenfs/webdav';

function App() {
    const [db, setDb] = useState(null);
    const [notes, setNotes] = useState([]);
    const [status, setStatus] = useState('初始化中...');

    useEffect(() => {
        initializeApp();
    }, []);

    async function initializeApp() {
        try {
            // 配置文件系统
            await configure({
                mounts: {
                    '/storage': {
                        backend: WebDAV,
                        url: process.env.REACT_APP_WEBDAV_URL,
                        username: process.env.REACT_APP_WEBDAV_USER,
                        password: process.env.REACT_APP_WEBDAV_PASSWORD
                    }
                }
            });

            // 创建数据库
            const database = new PouchDB('notes');
            setDb(database);

            // 加载笔记
            await loadNotes(database);
            setStatus('就绪');

        } catch (error) {
            setStatus('初始化失败: ' + error.message);
        }
    }

    async function loadNotes(database) {
        const result = await database.allDocs({
            include_docs: true,
            startkey: 'note_',
            endkey: 'note_\ufff0'
        });
        setNotes(result.rows.map(row => row.doc));
    }

    async function addNote(title, content) {
        await db.put({
            _id: 'note_' + Date.now(),
            title,
            content,
            createdAt: new Date().toISOString()
        });
        await loadNotes(db);
    }

    async function syncToCloud() {
        try {
            setStatus('同步中...');
            await sync(db, fs.promises, '/storage');
            setStatus('同步完成');
        } catch (error) {
            setStatus('同步失败: ' + error.message);
        }
    }

    return (
        <div>
            <h1>笔记应用</h1>
            <div>状态: {status}</div>
            <button onClick={syncToCloud}>同步到云端</button>
            {/* ... 其他 UI */}
        </div>
    );
}

export default App;
```

## 🎯 最佳实践

### 1. 错误处理

```javascript
async function safeSync() {
    try {
        await sync(db, fs.promises, '/storage');
        return { success: true };
    } catch (error) {
        console.error('同步失败:', error);
        
        // 根据错误类型处理
        if (error.message.includes('network')) {
            return { success: false, reason: 'network', message: '网络连接失败' };
        } else if (error.message.includes('auth')) {
            return { success: false, reason: 'auth', message: '认证失败' };
        } else {
            return { success: false, reason: 'unknown', message: error.message };
        }
    }
}
```

### 2. 定期自动同步

```javascript
class AutoSync {
    constructor(db, fs, interval = 5 * 60 * 1000) { // 默认 5 分钟
        this.db = db;
        this.fs = fs;
        this.interval = interval;
        this.timer = null;
    }

    start() {
        this.timer = setInterval(async () => {
            try {
                await sync(this.db, this.fs, '/storage');
                console.log('自动同步完成');
            } catch (error) {
                console.error('自动同步失败:', error);
            }
        }, this.interval);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

// 使用
const autoSync = new AutoSync(db, fs.promises);
autoSync.start();

// 页面卸载时停止
window.addEventListener('beforeunload', () => {
    autoSync.stop();
});
```

### 3. 离线支持

```javascript
class OfflineSync {
    constructor(db, fs) {
        this.db = db;
        this.fs = fs;
        this.online = navigator.onLine;
        
        window.addEventListener('online', () => this.handleOnline());
        window.addEventListener('offline', () => this.handleOffline());
    }

    async handleOnline() {
        console.log('网络已连接，开始同步...');
        this.online = true;
        
        try {
            await sync(this.db, this.fs, '/storage');
            console.log('恢复在线，同步完成');
        } catch (error) {
            console.error('同步失败:', error);
        }
    }

    handleOffline() {
        console.log('网络已断开，进入离线模式');
        this.online = false;
    }

    async syncIfOnline() {
        if (this.online) {
            await sync(this.db, this.fs, '/storage');
        } else {
            console.log('离线模式，跳过同步');
        }
    }
}
```

### 4. 进度反馈

```javascript
import { SyncEngine } from 'universal-sync-v2';

async function syncWithProgress(progressCallback) {
    const engine = new SyncEngine(db, fs.promises, {
        basePath: '/storage'
    });

    await engine.initialize();

    // 获取文档总数
    const info = await db.info();
    const total = info.doc_count;

    progressCallback(0, total, '开始同步...');

    // 执行同步
    await engine.sync();

    progressCallback(total, total, '同步完成！');
}

// 使用
await syncWithProgress((current, total, message) => {
    console.log(`${message} (${current}/${total})`);
    document.getElementById('progress').textContent = 
        `${Math.round(current/total*100)}%`;
});
```

## 🐛 故障排除

### 问题 1: CORS 错误

**症状**：
```
Access to fetch at '...' from origin '...' has been blocked by CORS policy
```

**解决方案**：

1. **配置 WebDAV 服务器允许 CORS**：

```nginx
# Nginx 配置
add_header 'Access-Control-Allow-Origin' '*';
add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE';
add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type, Depth';
```

2. **使用代理**：

```javascript
// 在开发环境使用代理
// vite.config.js
export default {
    server: {
        proxy: {
            '/webdav': {
                target: 'http://your-webdav-server.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/webdav/, '')
            }
        }
    }
};
```

### 问题 2: 认证失败

**症状**：
```
401 Unauthorized
```

**检查清单**：
- [ ] 用户名和密码是否正确
- [ ] WebDAV URL 是否正确（注意末尾的 `/`）
- [ ] 用户是否有权限访问该路径
- [ ] 是否需要应用专用密码（如 NextCloud）

### 问题 3: 性能问题

**症状**：同步很慢

**优化方案**：

```javascript
// 1. 减小文件大小
await sync(db, fs.promises, '/storage', {
    maxFileSize: 100 * 1024,  // 从 500KB 减少到 100KB
    chunkSize: 50             // 每个文件更少的文档
});

// 2. 启用自动合并
await sync(db, fs.promises, '/storage', {
    autoMerge: true,          // 自动合并小文件
    mergeThreshold: 50 * 1024 // 合并阈值
});

// 3. 使用批处理
const docs = [...]; // 大量文档
await db.bulkDocs(docs);  // 批量插入而不是逐个插入
```

### 问题 4: 浏览器兼容性

**解决方案**：

```html
<!-- 使用 polyfill -->
<script src="https://cdn.jsdelivr.net/npm/core-js-bundle@3/minified.js"></script>
<script src="https://cdn.jsdelivr.net/npm/regenerator-runtime@0.13/runtime.js"></script>

<!-- 或检测浏览器支持 -->
<script>
    if (!('Promise' in window) || !('fetch' in window)) {
        document.body.innerHTML = '抱歉，您的浏览器不支持此应用。请升级到最新版本。';
    }
</script>
```

## 📚 相关资源

- [完整 API 文档](./api.md)
- [使用指南](./usage-guide.md)
- [架构设计](./architecture.md)
- [浏览器测试页面](../test/index.html)
- [快速开始](../QUICKSTART.md)
