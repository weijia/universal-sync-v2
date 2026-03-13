// ==UserScript==
// @name         Universal 收藏 (示例)
// @namespace    https://example.com/
// @version      0.1
// @description  使用 universal-sync 将当前页面保存为收藏到 WebDAV（示例）
// @author       You
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Debug: indicate script loaded inside userscript sandbox
    try {
        console.log('universal-favorites userscript loaded', {
            hasWindow: !!window.UniversalSync,
            hasLocal: typeof UniversalSync !== 'undefined',
            GM_xmlhttpRequest: typeof GM_xmlhttpRequest !== 'undefined',
            GM_getValue: typeof GM_getValue !== 'undefined'
        });
    } catch (e) {
        // ignore
    }

    // Try to expose the bundled `UniversalSync` to the page as early as possible
    try {
        if (typeof unsafeWindow !== 'undefined') {
            try {
                if (typeof UniversalSync !== 'undefined') {
                    unsafeWindow.UniversalSync = UniversalSync;
                    console.log('early exposed UniversalSync to page via unsafeWindow');
                } else if (window && typeof window.UniversalSync !== 'undefined') {
                    unsafeWindow.UniversalSync = window.UniversalSync;
                    console.log('early exposed window.UniversalSync to page via unsafeWindow');
                }
            } catch (e) {
                console.warn('unable to early-expose UniversalSync to page', e && e.message ? e.message : e);
            }
        }
    } catch (e) {
        // noop
    }

    // In-page non-modal status panel (for save progress updates)
    function ensureStatusPanel() {
        let panel = document.getElementById('us-status-panel');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'us-status-panel';
        panel.style.position = 'fixed';
        panel.style.right = '12px';
        panel.style.bottom = '12px';
        panel.style.width = '300px';
        panel.style.maxWidth = '40%';
        panel.style.zIndex = '2147483647';
        panel.style.fontFamily = 'system-ui,Segoe UI,Roboto,Arial';
        panel.style.pointerEvents = 'auto';
        document.body.appendChild(panel);
        return panel;
    }

    function showStatus(message, opts = {}) {
        const panel = ensureStatusPanel();
        panel.innerHTML = '';
        const box = document.createElement('div');
        box.style.background = opts.bg || 'rgba(32,33,36,0.95)';
        box.style.color = opts.color || 'white';
        box.style.padding = '10px 12px';
        box.style.borderRadius = '8px';
        box.style.boxShadow = '0 6px 18px rgba(0,0,0,0.25)';
        box.style.marginTop = '6px';
        box.style.fontSize = '13px';
        box.style.lineHeight = '1.2';
        box.style.pointerEvents = 'auto';

        const title = document.createElement('div');
        title.textContent = opts.title || 'Universal 收藏';
        title.style.fontWeight = '600';
        title.style.marginBottom = '6px';
        box.appendChild(title);

        const msg = document.createElement('div');
        msg.id = 'us-status-message';
        msg.textContent = message;
        box.appendChild(msg);

        if (opts.progress) {
            const prog = document.createElement('div');
            prog.id = 'us-status-progress';
            prog.style.marginTop = '8px';
            prog.style.height = '6px';
            prog.style.background = 'rgba(255,255,255,0.12)';
            prog.style.borderRadius = '4px';
            prog.style.overflow = 'hidden';
            const inner = document.createElement('div');
            inner.style.width = (opts.progress * 100) + '%';
            inner.style.height = '100%';
            inner.style.background = opts.progressColor || '#4ade80';
            inner.style.transition = 'width 300ms linear';
            prog.appendChild(inner);
            box.appendChild(prog);
        }

        panel.appendChild(box);
        return panel;
    }

    function updateStatus(message, progress) {
        const msg = document.getElementById('us-status-message');
        if (msg) msg.textContent = message;
        const inner = document.querySelector('#us-status-progress > div');
        if (inner && typeof progress === 'number') inner.style.width = (progress * 100) + '%';
    }

    function finishStatus(message, success = true, autoHideMs = 3000) {
        const panel = ensureStatusPanel();
        const box = panel.firstChild;
        if (box) {
            box.style.background = success ? 'rgba(16,185,129,0.95)' : 'rgba(239,68,68,0.95)';
            const msg = document.getElementById('us-status-message');
            if (msg) msg.textContent = message;
        }
        if (autoHideMs) setTimeout(() => { try { panel.remove(); } catch(e){} }, autoHideMs);
    }

    const defaultLibUrl = `${location.origin}/dist/browser.js`;
    const defaultBasePath = 'app_data/favorites';

    function gmGet(key, fallback) {
        try { const v = GM_getValue(key); return v === undefined ? fallback : v; } catch(e) { return localStorage.getItem(key) ?? fallback; }
    }

    function gmSet(key, val) {
        try { GM_setValue(key, val); } catch(e) { localStorage.setItem(key, val); }
    }

    async function configureWebDAV() {
        const baseUrl = prompt('WebDAV baseUrl (例: https://webdav.example.com/remote.php/webdav/)', gmGet('us:baseUrl','')) || '';
        const username = prompt('用户名', gmGet('us:username','')) || '';
        const password = prompt('密码', gmGet('us:password','')) || '';
        // 使用固定库地址（默认指向项目 dist），不再提示输入 libUrl
        const libUrl = gmGet('us:libUrl', defaultLibUrl);
        const favoritesRoot = prompt('收藏存储根目录 (相对根路径，例如 app_data/favorites)', gmGet('us:favoritesRoot', defaultBasePath)) || defaultBasePath;

        gmSet('us:baseUrl', baseUrl);
        gmSet('us:username', username);
        gmSet('us:password', password);
        gmSet('us:libUrl', libUrl);
        gmSet('us:favoritesRoot', favoritesRoot);

        if (GM_notification) {
            GM_notification({ text: '配置已保存', title: 'Universal 收藏' });
        } else {
            console.log('配置已保存');
        }
    }

    async function savePageToFavorites() {
        const baseUrl = gmGet('us:baseUrl', '');
            console.log('savePageToFavorites called', { baseUrl });
            showStatus('准备保存收藏...', { title: '保存收藏', progress: 0 });
        if (!baseUrl) {
            if (GM_notification) {
                GM_notification({ text: '请先配置 WebDAV（脚本菜单 -> 配置 WebDAV）', title: 'Universal 收藏' });
            } else {
                console.warn('请先配置 WebDAV（脚本菜单 -> 配置 WebDAV）');
            }
            return;
        }

        try {
            // Prefer global UMD bundle (loaded via @require). Resolve cases where bundle
            // ends up as a module namespace with a `.default` export.
            const Uraw = (window.UniversalSync || (typeof UniversalSync !== 'undefined' ? UniversalSync : null));
            let U = Uraw;
            if (Uraw && typeof Uraw.createWebDAVFileSystem !== 'function' && Uraw.default && typeof Uraw.default.createWebDAVFileSystem === 'function') {
                U = Uraw.default;
            }
            let fs;
            // Debug: inspect raw module and resolved export
            try {
                console.log('UniversalSync (U) info:', {
                    Uraw,
                    U_value: U,
                    type_createWebDAV: U && typeof U.createWebDAVFileSystem,
                    has_gmHttpClient: U && !!U.gmHttpClient,
                    default_has_factory: !!(Uraw && Uraw.default && typeof Uraw.default.createWebDAVFileSystem === 'function')
                });
            } catch (e) { console.warn('error logging U info', e); }

            // Preferred flow:
            // 1) If a GM-capable http client is available, call low-level factory with httpClient.
            // 2) Otherwise prefer the higher-level createBrowserFS helper which will configure FS for browser.
            // Build a GM-based httpClient if available to bypass CORS restrictions
            let gmClientAvailable = false;
            let gmClient = undefined;
            try {
                if (typeof GM_xmlhttpRequest !== 'undefined') {
                    gmClientAvailable = true;
                    const parseHeaders = (raw) => {
                        const obj = {};
                        if (!raw) return obj;
                        raw.split('\r\n').forEach(line => {
                            const i = line.indexOf(':');
                            if (i>0) obj[line.slice(0,i).trim()] = line.slice(i+1).trim();
                        });
                        return obj;
                    };
                    gmClient = {
                        request(method, url, opts = {}) {
                            return new Promise((resolve, reject) => {
                                try {
                                    GM_xmlhttpRequest({
                                        method: method.toUpperCase(),
                                        url,
                                        headers: opts.headers,
                                        responseType: opts.responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
                                        data: opts.body,
                                        onload: (res) => resolve({ data: res.response, status: res.status, headers: parseHeaders(res.responseHeaders) }),
                                        onerror: (err) => reject(err),
                                        ontimeout: (err) => reject(err)
                                    });
                                } catch (e) { reject(e); }
                            });
                        }
                    };
                }
            } catch (e) {
                gmClientAvailable = false;
            }

            // If GM XHR is available, patch global fetch to use it so library calls using
            // `fetch` will bypass browser CORS (preflight) restrictions.
            if (gmClientAvailable) {
                try {
                    const originalFetch = window.fetch;
                    window.fetch = async function(input, init = {}) {
                        const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
                        const url = typeof input === 'string' ? input : input.url;
                        const headers = (init && init.headers) || {};
                        const body = init && init.body;
                        return new Promise((resolve, reject) => {
                            try {
                                GM_xmlhttpRequest({
                                    method: method.toUpperCase(),
                                    url,
                                    headers,
                                    data: body,
                                    responseType: 'arraybuffer',
                                    onload: (res) => {
                                        const hdrs = {};
                                        (res.responseHeaders || '').split('\r\n').forEach(line => {
                                            const i = line.indexOf(':'); if (i>0) hdrs[line.slice(0,i).trim().toLowerCase()] = line.slice(i+1).trim();
                                        });
                                        const buf = res.response instanceof ArrayBuffer ? res.response : undefined;
                                        const text = buf ? new TextDecoder().decode(new Uint8Array(buf)) : res.responseText;
                                        const headersObj = {
                                            get: (k) => hdrs[k.toLowerCase()] || null,
                                            forEach: (cb) => Object.entries(hdrs).forEach(([k, v]) => cb(v, k)),
                                            entries: () => Object.entries(hdrs),
                                            keys: () => Object.keys(hdrs),
                                        };
                                        resolve({
                                            ok: res.status >= 200 && res.status < 300,
                                            status: res.status,
                                            statusText: res.statusText,
                                            headers: headersObj,
                                            arrayBuffer: async () => buf,
                                            text: async () => text,
                                            json: async () => JSON.parse(text)
                                        });
                                    },
                                    onerror: (err) => reject(err),
                                    ontimeout: (err) => reject(err)
                                });
                            } catch (e) { reject(e); }
                        });
                    };
                    console.log('patched window.fetch to use GM_xmlhttpRequest');
                } catch (e) {
                    console.warn('failed to patch fetch', e);
                }
            }

            try {
                if (U && (U.gmHttpClient || (U.default && U.default.gmHttpClient))) {
                    const impl = U.gmHttpClient || (U.default && U.default.gmHttpClient);
                    if (typeof U.createWebDAVFileSystem === 'function') {
                        fs = U.createWebDAVFileSystem({ baseUrl: baseUrl, username: gmGet('us:username','') || undefined, password: gmGet('us:password','') || undefined, httpClient: (gmClientAvailable ? gmClient : impl) });
                        console.log('created fs from UniversalSync.createWebDAVFileSystem (with gmHttpClient)', { fsExists: !!fs });
                    }
                }
                if (!fs && U && typeof U.createBrowserFS === 'function') {
                    try {
                        fs = await U.createBrowserFS({ webdav: { baseUrl, username: gmGet('us:username','') || undefined, password: gmGet('us:password','') || undefined } });
                        console.log('created fs from UniversalSync.createBrowserFS', { fsExists: !!fs });
                    } catch (e) {
                        console.warn('createBrowserFS failed', e && e.message ? e.message : e);
                    }
                }
                if (!fs && U && typeof U.createWebDAVFileSystem === 'function') {
                    // final fallback: try createWebDAVFileSystem without gm adapter
                    fs = U.createWebDAVFileSystem({ baseUrl: baseUrl, username: gmGet('us:username','') || undefined, password: gmGet('us:password','') || undefined });
                    console.log('created fs from UniversalSync.createWebDAVFileSystem (fallback)', { fsExists: !!fs });
                }
            } catch (e) {
                console.error('Error creating FS from UniversalSync exports', e);
            }
                try {
                    if (typeof unsafeWindow !== 'undefined') {
                        unsafeWindow.UniversalSync = U;
                        console.log('exposed UniversalSync to page via unsafeWindow');
                    }
                } catch (e) {
                    console.warn('unable to expose UniversalSync to page', e && e.message ? e.message : e);
                }

            const root = gmGet('us:favoritesRoot', defaultBasePath).replace(/^\/+|\/+$/g,'');
            const fullBase = `/${root}`;

            // 准备数据
            const data = {
                url: location.href,
                title: document.title,
                ts: Date.now(),
                meta: {
                    hostname: location.hostname,
                    pathname: location.pathname
                }
            };

            // 先写入内存字典（Pouch-like），再把内存 DB 同步到文件系统（WebDAV）
            const createMemoryPouch = () => {
                const docs = new Map();
                let seq = 0;
                return {
                    async info() { return { db_name: 'memory', doc_count: docs.size, update_seq: seq }; },
                    async get(id) { if (!docs.has(id)) { const e = new Error('missing'); e.status = 404; throw e; } return { ...docs.get(id) }; },
                    async bulkDocs(arr) {
                        if (!Array.isArray(arr)) arr = [arr];
                        const results = [];
                        for (const d of arr) {
                            const id = d._id || `fav-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
                            seq += 1;
                            const rev = `${seq}-local`;
                            const stored = { ...d, _id: id, _rev: rev };
                            docs.set(id, stored);
                            results.push({ id, ok: true, rev });
                        }
                        return { results };
                    },
                    async allDocs(opts = {}) {
                        const rows = [];
                        for (const [id, doc] of docs.entries()) {
                            if (opts.include_docs) rows.push({ id, doc: { ...doc } });
                            else rows.push({ id });
                        }
                        return { total_rows: rows.length, offset: 0, rows };
                    }
                };
            };

            const memDb = createMemoryPouch();
            // 插入文档到内存 DB（使用 bulkDocs 以兼容 sync 引擎预期）
            await memDb.bulkDocs([{ _id: `fav:${Date.now()}`, ...data }]);
            updateStatus('已写入内存，准备同步到文件系统...', 0.2);

            // 如果库导出 sync，则使用它把内存 DB 同步到 fs 的目标路径；否则回退到直接写文件
            if (U && typeof U.sync === 'function') {
                try {
                    updateStatus('正在同步到 WebDAV...', 0.5);
                    await U.sync(memDb, fs, fullBase);
                    updateStatus('同步完成，正在写入索引...', 0.95);
                    finishStatus('保存完成', true, 2500);
                    console.log('synced memory DB to fs via U.sync', { base: fullBase });
                } catch (e) {
                    console.error('sync failed', e);
                    finishStatus('同步失败: ' + (e && e.message ? e.message : String(e)), false, 8000);
                    throw e;
                }
            } else {
                // fallback: 确保目录存在并直接写文件
                await fs.mkdir(fullBase, { recursive: true });
                const safeTitle = (document.title || 'page').replace(/[^a-z0-9\-\_]/ig,'_').slice(0,80);
                const filename = `${fullBase}/fav-${safeTitle}-${Date.now()}.json`;
                await fs.writeFile(filename, JSON.stringify(data, null, 2));
                finishStatus('保存完成（直接写入）', true, 2500);
            }

            if (GM_notification) {
                GM_notification({ text: '页面已保存到收藏', title: 'Universal 收藏' });
            } else {
                console.log('页面已保存到收藏');
            }
        } catch (e) {
            console.error(e);
            const msg = '保存失败: ' + (e && e.message ? e.message : String(e));
            if (GM_notification) {
                GM_notification({ text: msg, title: 'Universal 收藏 - 错误' });
            } else {
                console.warn(msg);
            }
        }
    }

    // 注册菜单命令
    try {
        GM_registerMenuCommand && GM_registerMenuCommand('配置 WebDAV & 脚本设置', configureWebDAV);
        GM_registerMenuCommand && GM_registerMenuCommand('保存页面到收藏', savePageToFavorites);
    } catch (e) {
        // fallback: add small floating button
        const btn = document.createElement('button');
        btn.textContent = '收藏页面';
        btn.style.position = 'fixed'; btn.style.right = '10px'; btn.style.bottom = '10px'; btn.style.zIndex = '99999';
        btn.style.padding = '8px 12px'; btn.style.background = '#667eea'; btn.style.color = 'white'; btn.style.border = 'none'; btn.style.borderRadius = '6px';
        btn.addEventListener('click', savePageToFavorites);
        document.body.appendChild(btn);
        // also add configure via double-click
        btn.addEventListener('dblclick', configureWebDAV);
    }

})();
