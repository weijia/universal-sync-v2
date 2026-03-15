// ==UserScript==
// @name         Universal 收藏（直接写入示例）
// @namespace    https://example.com/
// @version      0.1
// @description  直接使用 saveDocumentToFs 将收藏写入目标文件系统（不走 sync）
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

(function(){
  'use strict';

  function gmGet(key, fallback) { try { const v = GM_getValue(key); return v === undefined ? fallback : v } catch(e){ return localStorage.getItem(key) ?? fallback } }
  function gmSet(key, val) { try { GM_setValue(key, val) } catch(e) { localStorage.setItem(key, val) } }

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

  async function configure(){
    const baseUrl = prompt('WebDAV baseUrl', gmGet('us:baseUrl','')) || '';
    const favoritesRoot = prompt('收藏存储根目录 (例如 app_data/favorites)', gmGet('us:favoritesRoot','app_data/favorites')) || 'app_data/favorites';
    gmSet('us:baseUrl', baseUrl);
    gmSet('us:favoritesRoot', favoritesRoot);
    if (GM_notification) GM_notification({ text: '配置已保存', title: 'Universal 收藏' });
  }

  async function saveDirect(){
    const baseUrl = gmGet('us:baseUrl','');
    if (!baseUrl) { if (GM_notification) GM_notification({ text: '请先配置 WebDAV', title: 'Universal 收藏' }); return; }
    try { showStatus('准备保存收藏...', { title: '保存收藏', progress: 0 }); } catch (e) {}

    // Resolve bundled UMD (could be window.UniversalSync or UniversalSync)
    const Uraw = (window.UniversalSync || (typeof UniversalSync !== 'undefined' ? UniversalSync : null));
    let U = Uraw;
    if (Uraw && Uraw.default && typeof Uraw.default.saveDocumentToFs === 'function') U = Uraw.default;

    // Build a GM-based http client if available to bypass CORS preflight
    let fs = null;
    let gmClientAvailable = false;
    let gmClient = undefined;
    try { console.log('direct: GM_xmlhttpRequest available?', typeof GM_xmlhttpRequest !== 'undefined'); } catch(e){}
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
                  // gmClient is available; prefer passing it explicitly when creating FS
              } catch (e) { reject(e); }
            });
          }
        };
      }
    } catch (e) {
      gmClientAvailable = false;
      console.log(e, 'gmClient not avail')
    }

    // If GM XHR is available, patch window.fetch similarly so code paths using fetch bypass CORS.
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
                  (res.responseHeaders || '').split('\r\n').forEach(line => { const i = line.indexOf(':'); if (i>0) hdrs[line.slice(0,i).trim().toLowerCase()] = line.slice(i+1).trim(); });
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
        console.log('direct: patched window.fetch to use GM_xmlhttpRequest');
      } catch (e) { console.warn('direct: failed to patch fetch', e); }
    }

    // Prefer factory flow similar to main userscript: try createWebDAVFileSystem with gmClient, then createBrowserFS, then fallback
    try {
      // Normalize U export (handle U.default)
      let Uimpl = U;
      if (Uraw && typeof Uraw.createWebDAVFileSystem !== 'function' && Uraw.default && typeof Uraw.default.createWebDAVFileSystem === 'function') {
        Uimpl = Uraw.default;
      }

      // If library provides its own gmHttpClient impl, prefer our constructed gmClient when available
      const libHasGm = !!(Uimpl && (Uimpl.gmHttpClient || (Uimpl.default && Uimpl.default.gmHttpClient)));

      if (Uimpl && (Uimpl.gmHttpClient || (Uimpl.default && Uimpl.default.gmHttpClient))) {
        const impl = Uimpl.gmHttpClient || (Uimpl.default && Uimpl.default.gmHttpClient);
        if (typeof Uimpl.createWebDAVFileSystem === 'function') {
          const opts = { baseUrl: baseUrl, username: undefined, password: undefined };
          if (gmClient) opts.httpClient = gmClient; else if (gmClientAvailable) opts.httpClient = gmClient; else if (impl) opts.httpClient = impl;
          try { console.log('direct: calling createWebDAVFileSystem with opts', Object.assign({}, opts, { httpClientPresent: !!opts.httpClient })); } catch(e){}
          fs = Uimpl.createWebDAVFileSystem(opts);
          console.log('direct: created fs from createWebDAVFileSystem (with gmHttpClient)', { fsExists: !!fs });
        }
      }

      if (!fs && Uimpl && typeof Uimpl.createBrowserFS === 'function') {
        try {
          fs = await Uimpl.createBrowserFS({ webdav: { baseUrl, username: undefined, password: undefined } });
          console.log('direct: created fs from createBrowserFS', { fsExists: !!fs });
        } catch (e) {
          console.warn('direct: createBrowserFS failed', e && e.message ? e.message : e);
        }
      }

      if (!fs && Uimpl && typeof Uimpl.createWebDAVFileSystem === 'function') {
        // final fallback: try createWebDAVFileSystem without gm adapter
        fs = Uimpl.createWebDAVFileSystem({ baseUrl: baseUrl, username: undefined, password: undefined });
        console.log('direct: created fs from createWebDAVFileSystem (fallback)', { fsExists: !!fs });
      }
    } catch (e) {
      console.warn('direct: Error creating FS from UniversalSync exports', e);
    }

    try {
      if (typeof unsafeWindow !== 'undefined') {
        unsafeWindow.UniversalSync = U;
        console.log('direct: exposed UniversalSync to page via unsafeWindow');
      }
    } catch (e) { console.warn('direct: unable to expose UniversalSync to page', e && e.message ? e.message : e); }

    if (!fs) { console.error('无法创建文件系统'); if (GM_notification) GM_notification({ text: '无法创建文件系统', title: 'Universal 收藏' }); finishStatus('无法创建文件系统', false, 4000); return; }

    try { updateStatus('已连接文件系统，准备写入...', 0.2); } catch (e) {}

    const data = { url: location.href, title: document.title, ts: Date.now(), meta: { hostname: location.hostname, pathname: location.pathname } };
    const doc = { _id: `fav:${Date.now()}`, ...data };

    if (U && typeof U.saveDocumentToFs === 'function') {
      try {
        try { updateStatus('正在保存到服务器...', 0.6); } catch (e) {}
        await U.saveDocumentToFs(fs, '/' + gmGet('us:favoritesRoot','app_data/favorites'), doc, { disableManifest: true });
        try { finishStatus('已保存收藏（直接写入）', true, 2500); } catch (e) {}
        if (GM_notification) GM_notification({ text: '已保存收藏（直接写入）', title: 'Universal 收藏' });
      } catch (e) {
        console.error(e);
        try { finishStatus('保存失败: ' + (e && e.message ? e.message : String(e)), false, 8000); } catch (ex) {}
        if (GM_notification) GM_notification({ text: '保存失败: ' + (e && e.message ? e.message : String(e)), title: 'Universal 收藏' });
      }
    } else {
      console.error('saveDocumentToFs 不可用');
      if (GM_notification) GM_notification({ text: '功能不可用，请确保脚本包含库', title: 'Universal 收藏' });
    }
  }

  try {
    GM_registerMenuCommand && GM_registerMenuCommand('配置 WebDAV', configure);
    GM_registerMenuCommand && GM_registerMenuCommand('直接保存收藏', saveDirect);
  } catch(e){ console.warn('menu register failed', e); }

})();
