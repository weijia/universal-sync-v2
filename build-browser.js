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
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';

const umdPath = resolve('dist/browser.umd.js');

// Build a merged userscript for every example userscript under examples/userscripts/*
try {
  const umd = readFileSync(umdPath, { encoding: 'utf8' });

  const examplesRoot = resolve('examples/userscripts');
  const groups = readdirSync(examplesRoot).filter(name => {
    const p = join(examplesRoot, name);
    return statSync(p).isDirectory();
  });

  for (const g of groups) {
    const dir = join(examplesRoot, g);
    const files = readdirSync(dir).filter(f => f.endsWith('.user.js'));
    for (const f of files) {
      const exampleScriptPath = join(dir, f);
      const outScriptPath = join(dir, f.replace(/\.user\.js$/, '.user.build.js'));
      try {
        let wrapper = readFileSync(exampleScriptPath, { encoding: 'utf8' });
        wrapper = wrapper.replace(/^\s*\/\/ ==UserScript==[\s\S]*?==\/UserScript==\s*/m, '');
        wrapper = wrapper.replace(/\(window as any\)/g, 'window');

        const header = `// ==UserScript==\n// @name         Universal 收藏（包含库）\n// @namespace    https://example.com/\n// @version      0.1\n// @description  包含 universal-sync 库的 userscript 示例（自动打包）\n// @author       Build System\n// @match        *://*/*\n// @grant        GM_registerMenuCommand\n// @grant        GM_getValue\n// @grant        GM_setValue\n// @grant        GM_notification\n// @grant        GM_xmlhttpRequest\n// @grant        unsafeWindow\n// @connect      *\n// @run-at       document-end\n// ==/UserScript==\n\n`;

        const finalContent = header + '\n' + '// --- Embedded UMD bundle (dist/browser.umd.js) ---\n' + umd + '\n\n' + '// --- Userscript wrapper ---\n' + wrapper;
        writeFileSync(outScriptPath, finalContent, { encoding: 'utf8' });
        console.log('  -', outScriptPath, '(userscript with embedded UMD)');
      } catch (e) {
        console.warn('Failed to build userscript for', exampleScriptPath, e && e.message ? e.message : e);
      }
    }
  }
} catch (e) {
  console.warn('Could not build userscripts:', e && e.message ? e.message : e);
}
