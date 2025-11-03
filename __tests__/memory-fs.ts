import { IFileSystem } from '../src/types';

/**
 * 内存文件系统实现，用于测试
 */
export class MemoryFileSystem implements IFileSystem {
  private files: Map<string, string> = new Map();
  private dirs: Set<string> = new Set();

  constructor() {
    this.dirs.add('/');
  }

  async readFile(path: string, encoding: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return content;
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data);
    
    // 确保父目录存在
    const dir = this.dirname(path);
    this.dirs.add(dir);
  }

  async readdir(path: string): Promise<string[]> {
    if (!this.dirs.has(path)) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    const results: string[] = [];
    const prefix = path === '/' ? '/' : path + '/';

    // 查找直接子文件
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const relativePath = filePath.substring(prefix.length);
        const slashIndex = relativePath.indexOf('/');
        
        if (slashIndex === -1) {
          // 这是一个文件
          results.push(relativePath);
        }
      }
    }

    // 查找直接子目录
    for (const dir of this.dirs) {
      if (dir !== path && dir.startsWith(prefix)) {
        const relativePath = dir.substring(prefix.length);
        const slashIndex = relativePath.indexOf('/');
        
        if (slashIndex === -1 && !results.includes(relativePath)) {
          results.push(relativePath);
        }
      }
    }

    return results;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      const parts = path.split('/').filter(p => p);
      let currentPath = '';
      
      for (const part of parts) {
        currentPath += '/' + part;
        this.dirs.add(currentPath);
      }
    } else {
      this.dirs.add(path);
    }
  }

  async stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtime: Date }> {
    const isFile = this.files.has(path);
    const isDirectory = this.dirs.has(path);

    if (!isFile && !isDirectory) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    return {
      isFile: () => isFile,
      isDirectory: () => isDirectory,
      mtime: new Date(),
    };
  }

  async unlink(path: string): Promise<void> {
    if (!this.files.has(path)) {
      throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
    }
    this.files.delete(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, rename '${oldPath}'`);
    }
    
    this.files.set(newPath, content);
    this.files.delete(oldPath);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  // 辅助方法
  private dirname(path: string): string {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash > 0 ? path.substring(0, lastSlash) : '/';
  }

  // 测试辅助方法
  clear(): void {
    this.files.clear();
    this.dirs.clear();
    this.dirs.add('/');
  }

  getFileCount(): number {
    return this.files.size;
  }

  getAllFiles(): string[] {
    return Array.from(this.files.keys());
  }
}
