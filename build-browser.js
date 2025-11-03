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
