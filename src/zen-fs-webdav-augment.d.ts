// 对 npm 包 zen-fs-webdav 的类型补充（module augmentation）。
// npm 版 0.1.5 的 WebDAVFileSystem 在运行时提供 fs.promises 兼容方法（readdir 等），
// 但其自带 .d.ts 未导出这些方法，这里补上，使 universal-sync-v2 的 IFileSystem.readdir 调用通过类型检查。
declare module 'zen-fs-webdav' {
  export interface WebDAVFileSystem {
    /** fs.promises.readdir 兼容：返回文件名数组 */
    readdir(path: string): Promise<string[]>;
    /** 兼容 Node.js fs.promises.rename 语义（部分环境需要） */
    rename?(oldPath: string, newPath: string): Promise<void>;
  }
}
