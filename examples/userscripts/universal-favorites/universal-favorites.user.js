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

        alert('配置已保存');
    }

    async function savePageToFavorites() {
        const baseUrl = gmGet('us:baseUrl', '');
        console.log('savePageToFavorites called', { baseUrl });
        if (!baseUrl) { alert('请先配置 WebDAV（脚本菜单 -> 配置 WebDAV）'); return; }

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
            try {
                if (U && (U.gmHttpClient || (U.default && U.default.gmHttpClient))) {
                    const gmClient = U.gmHttpClient || (U.default && U.default.gmHttpClient);
                    if (typeof U.createWebDAVFileSystem === 'function') {
                        fs = U.createWebDAVFileSystem({ baseUrl: baseUrl, username: gmGet('us:username','') || undefined, password: gmGet('us:password','') || undefined, httpClient: gmClient });
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

            // 确保目录存在
            await fs.mkdir(fullBase, { recursive: true });

            const safeTitle = (document.title || 'page').replace(/[^a-z0-9\-\_]/ig,'_').slice(0,80);
            const filename = `${fullBase}/fav-${safeTitle}-${Date.now()}.json`;
            await fs.writeFile(filename, JSON.stringify(data, null, 2));

            GM_notification && GM_notification({ text: '页面已保存到收藏', title: 'Universal 收藏' });
            alert('页面已保存到收藏');
        } catch (e) {
            console.error(e);
            alert('保存失败: ' + (e && e.message ? e.message : String(e)));
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
