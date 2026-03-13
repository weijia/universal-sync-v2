/**
 * 通用文件系统接口，兼容 Node.js fs 和浏览器 fs 实现
 */
export interface IFileSystem {
  readFile(path: string, encoding: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtime: Date }>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/**
 * 存储的文档数据
 */
export interface StoredDocument {
  _id: string;
  _rev: string;
  _deleted?: boolean;
  [key: string]: any;
}

/**
 * 数据文件元数据
 */
export interface DataFileMetadata {
  filename: string;
  startSeq: number;
  endSeq: number;
  timestamp: number;
  documentCount: number;
  mergedFrom?: string[]; // 如果是合并文件，记录源文件
  partition?: string; // 可选：分区路径，例如 "2026/03"
}

/**
 * 数据文件内容
 */
export interface DataFileContent {
  version: string;
  timestamp: number;
  sequence: number;
  documents: StoredDocument[];
  metadata?: DataFileMetadata;
}

/**
 * 清单文件内容（用于跟踪所有数据文件）
 */
export interface ManifestContent {
  version: string;
  lastSequence: number;
  lastTimestamp: number;
  files: DataFileMetadata[];
}

/**
 * 清单索引（用于记录分区清单）
 */
export interface ManifestIndexContent {
  version: string;
  partitions: {
    [partition: string]: {
      manifestPath: string;
      lastSequence: number;
      lastTimestamp: number;
    };
  };
}

/**
 * 同步选项
 */
export interface SyncOptions {
  basePath: string;
  maxFileSize?: number; // 最大文件大小（字节），默认 1MB
  maxFilesPerDirectory?: number; // 每个目录最大文件数，默认 1000
  mergeThreshold?: number; // 文件合并阈值（字节），默认 100KB
  mergeInterval?: number; // 合并检查间隔（毫秒），默认 60000
  autoMerge?: boolean; // 是否自动合并，默认 true
}

/**
 * 锁信息
 */
export interface LockInfo {
  id: string;
  timestamp: number;
  operation: string;
}
