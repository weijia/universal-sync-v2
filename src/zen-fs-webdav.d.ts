declare module 'zen-fs-webdav' {
  export interface WebDAVOptions {
    baseUrl: string;
    username?: string;
    password?: string;
  }

  export function createWebDAVFileSystem(options: WebDAVOptions): any;
}
