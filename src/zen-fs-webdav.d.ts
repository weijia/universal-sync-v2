// 本地对 npm 包 zen-fs-webdav 的完整类型声明。
// npm 版 0.1.5 的 .d.ts 因 UMD 打包 + 无 exports 字段，TypeScript 解析命名导入会失败，
// 这里显式声明所需 API（与运行时一致：已确认 dist/index.js 提供 createWebDAVFileSystem / readdir 等）。
declare module 'zen-fs-webdav' {
  export interface WebDAVOptions {
    baseUrl: string;
    username?: string;
    password?: string;
    token?: string;
    headers?: Record<string, string>;
    timeout?: number;
    debug?: boolean;
  }

  export interface WebDAVFileSystem {
    readFile(path: string, encoding?: string): Promise<string>;
    readFile(path: string, options?: { responseType?: 'text' | 'arraybuffer'; encoding?: string }): Promise<any>;
    writeFile(path: string, data: Buffer | string, options?: { overwrite?: boolean; contentType?: string }): Promise<any>;
    deleteFile(path: string): Promise<any>;
    readDir(path: string, options?: { recursive?: boolean; includeHidden?: boolean }): Promise<Array<{ name: string; isDirectory: boolean; path: string }>>;
    /** fs.promises.readdir 兼容：返回文件名数组 */
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rmdir(path: string, options?: boolean | { recursive?: boolean; force?: boolean }): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number; lastModified?: Date; name: string; path: string }>;
    exists(path: string): Promise<boolean>;
    copy(source: string, destination: string, overwrite?: boolean): Promise<any>;
    move(source: string, destination: string, overwrite?: boolean): Promise<any>;
    unlink(path: string): Promise<any>;
  }

  export function createWebDAVFileSystem(options: WebDAVOptions): WebDAVFileSystem;
}
