import { IFileSystem } from '../types.js';

/**
 * 文件系统工具类
 * 提供跨平台的文件操作封装
 */
export class FileSystemUtils {
  constructor(private fs: IFileSystem) {}

  /**
   * 确保目录存在
   */
  async ensureDir(path: string): Promise<void> {
    try {
      const exists = await this.fs.exists(path);
      if (!exists) {
        await this.fs.mkdir(path, { recursive: true });
      }
    } catch (error) {
      // 目录可能已经存在，忽略错误
    }
  }

  /**
   * 读取 JSON 文件
   */
  async readJSON<T>(path: string): Promise<T> {
    const content = await this.fs.readFile(path, 'utf8');
    return JSON.parse(content) as T;
  }

  /**
   * 写入 JSON 文件
   */
  async writeJSON(path: string, data: any): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    await this.fs.writeFile(path, content);
  }

  /**
   * 检查文件是否存在
   */
  async fileExists(path: string): Promise<boolean> {
    try {
      return await this.fs.exists(path);
    } catch {
      return false;
    }
  }

  /**
   * 获取文件大小
   */
  async getFileSize(path: string): Promise<number> {
    const content = await this.fs.readFile(path, 'utf8');
    return new TextEncoder().encode(content).length;
  }

  /**
   * 列出目录中的所有文件
   */
  async listFiles(dir: string, pattern?: RegExp): Promise<string[]> {
    try {
      const files = await this.fs.readdir(dir);
      if (pattern) {
        return files.filter((f: string) => pattern.test(f));
      }
      return files;
    } catch {
      return [];
    }
  }

  /**
   * 连接路径
   */
  joinPath(...parts: string[]): string {
    return parts.join('/').replace(/\/+/g, '/');
  }

  /**
   * 原子性写入（先写临时文件再重命名）
   */
  async atomicWrite(path: string, data: any): Promise<void> {
    const tempPath = `${path}.tmp`;
    await this.writeJSON(tempPath, data);
    await this.fs.rename(tempPath, path);
  }
}
