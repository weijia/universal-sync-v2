import * as esbuild from 'esbuild';

// 构建浏览器版本 - 包含所有依赖的单一 bundle
await esbuild.build({
  entryPoints: ['src/browser-entry.ts'],
  bundle: true,
  outfile: 'dist/browser.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: false,
  external: [
    'pouchdb-core', // PouchDB 需要用户自己提供
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: '// Universal Sync V2 - Browser Bundle\n// This bundle includes all dependencies except PouchDB\n',
  },
});

// 构建压缩版本
await esbuild.build({
  entryPoints: ['src/browser-entry.ts'],
  bundle: true,
  outfile: 'dist/browser.min.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: true,
  external: [
    'pouchdb-core',
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

console.log('✅ Browser bundles created successfully!');
console.log('  - dist/browser.js (development)');
console.log('  - dist/browser.min.js (production)');

// 另外生成一个 UMD/IIFE 版本，便于 userscript 或直接通过 <script> 引入
await esbuild.build({
  entryPoints: ['src/browser-entry.ts'],
  bundle: true,
  outfile: 'dist/browser.umd.js',
  format: 'iife',
  globalName: 'UniversalSync',
  platform: 'browser',
  target: 'es2020',
  sourcemap: false,
  minify: false,
  external: [
    'pouchdb-core',
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: '// Universal Sync V2 - Browser UMD/IIFE Bundle\n// Attaches exports to `window.UniversalSync`\n',
  },
});

console.log('  - dist/browser.umd.js (iife global: window.UniversalSync)');

// === 生成 userscript（将 UMD bundle 与示例 userscript 合并） ===
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const umdPath = resolve('dist/browser.umd.js');
const exampleScriptPath = resolve('examples/userscripts/universal-favorites/universal-favorites.user.js');
const outScriptPath = resolve('examples/userscripts/universal-favorites/universal-favorites.user.build.js');

try {
  const umd = readFileSync(umdPath, { encoding: 'utf8' });
  let wrapper = readFileSync(exampleScriptPath, { encoding: 'utf8' });

  // Remove the userscript metadata block from wrapper (we will add a cleaned header)
  wrapper = wrapper.replace(/^\s*\/\/ ==UserScript==[\s\S]*?==\/UserScript==\s*/m, '');

  // Remove TypeScript cast patterns like (window as any) -> window
  wrapper = wrapper.replace(/\(window as any\)/g, 'window');

  // Build a safe userscript header for the bundled script
  const header = `// ==UserScript==
// @name         Universal 收藏（包含库）
// @namespace    https://example.com/
// @version      0.1
// @description  包含 universal-sync 库的 userscript 示例（自动打包）
// @author       Build System
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-end
// ==/UserScript==\n\n`;

  const finalContent = header + '\n' + '// --- Embedded UMD bundle (dist/browser.umd.js) ---\n' + umd + '\n\n' + '// --- Userscript wrapper ---\n' + wrapper;

  writeFileSync(outScriptPath, finalContent, { encoding: 'utf8' });
  console.log('  - examples/userscripts/universal-favorites/universal-favorites.user.build.js (userscript with embedded UMD)');
} catch (e) {
  console.warn('Could not build userscript:', e && e.message ? e.message : e);
}
