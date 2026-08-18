/**
 * 通用文件系统接口，兼容 Node.js fs 和浏览器 fs 实现
 *
 * `size()` 和 `rmdir()` 为可选方法——某些后端适配器（如
 * zen-fs-remotestoragejs 的 adaptFileSystem）不提供这两个方法，
 * 调用方应通过 try/catch 或类型守卫来处理其缺失的情况。
 */
export interface IFileSystem {
  readFile(path: string, encoding: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtime: Date }>;
  size?(path: string): Promise<number>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  rmdir?(path: string): Promise<void>;
}

/**
 * 存储的文档数据
 */
export interface StoredDocument {
  _id: string;
  _rev: string;
  _deleted?: boolean;
  _revisions?: {
    start: number;
    ids: string[];
  };
  [key: string]: any;
}

export type SyncConflictReason =
  | 'same'
  | 'remote-newer'
  | 'local-newer'
  | 'conflict'
  | 'unknown';

export interface SyncConflictContext {
  docId: string;
  direction: 'pull' | 'push';
  reason: SyncConflictReason;
  localRev?: string;
  remoteRev?: string;
}

export type SyncConflictDecision =
  | { action: 'use-local'; reason?: string }
  | { action: 'use-remote'; reason?: string }
  | { action: 'merge'; doc: StoredDocument | Record<string, any>; reason?: string }
  | { action: 'keep-conflict'; reason?: string };

export type SyncConflictResolver = (
  localDoc: StoredDocument | Record<string, any>,
  remoteDoc: StoredDocument | Record<string, any>,
  context: SyncConflictContext
) => SyncConflictDecision | Promise<SyncConflictDecision>;

/**
 * 数据文件内容（rev2：去 sequence，仅由 _rev 决定版本）
 */
export interface DataFileContent {
  version: string;
  timestamp: number;
  documents: StoredDocument[];
}

/**
 * 同步选项（rev2：去 manifest / 全局 sequence / 目录重排）
 */
export interface SyncOptions {
  basePath: string;
  maxFileSize?: number; // 单文件体积上限（字节），默认 2MB；超过则拆成多个 data 文件
  mergeThreshold?: number; // 文件合并阈值（字节），默认 100KB
  mergeCheckInterval?: number; // 合并检查间隔（毫秒），默认 3600_000（1 小时）。多久醒来看看本月要不要合并。真正合并频率由 UTC 月份标记控制，每台设备每月至多合并一次，避免跨时区/多设备重复合并
  autoMerge?: boolean; // 是否自动合并，默认 true
  conflictResolver?: SyncConflictResolver; // 可选：由业务层决定冲突文档使用本地、远端、合并或保留冲突
  onProgress?: SyncProgressCallback; // 可选：同步进度回调，用于 UI 展示
}

/**
 * 同步进度（阶段 + 各维度计数）。业务层可据此展示「服务器剩余 N 个文件待读取」「本地 M 条记录待上传」等提示。
 * - phase: 'pull' | 'push' | 'done' | 'skip'
 * - pull 阶段：remoteFilesTotal=服务器数据文件总数，remoteFilesRead=已读取文件数，localPendingToApply=待写入本地的记录数
 * - push 阶段：localDocsTotal=本地待上传文档数，localFilesWritten=已写入服务器的文件数，localFilesTotal=将生成的文件总数
 */
export interface SyncProgress {
  phase: 'pull' | 'push' | 'done' | 'skip' | 'error';
  remoteFilesTotal?: number; // 服务器数据文件总数（pull 开始）
  remoteFilesRead?: number; // 已读取的服务器文件数
  localPendingToApply?: number; // 待写入本地的记录数（pull 解析后）
  localDocsTotal?: number; // 本地待上传文档数（push 开始）
  localFilesWritten?: number; // 已写入服务器的文件数（push 写入后）
  localFilesTotal?: number; // 本次 push 将生成的文件总数
  message?: string; // 人类可读提示
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

/**
 * 本地缓存：记录目标文件系统每个文档的 _rev（push 差异筛选用）
 */
export interface RemoteRevCache {
  basePath: string;
  revs: Record<string, string>; // docId -> _rev
}

/**
 * 本地缓存：记录已写入文件的内容哈希（pull 跳过未变文件用）
 */
export interface ProcessedFilesCache {
  basePath: string;
  hashes: Record<string, string>; // filePath -> contentHash
}

/**
 * 本地缓存：上次 push 的 update_seq（轻量跳过用）
 */
export interface SyncSeqCache {
  basePath: string;
  lastPushedSeq: number | null;
}

/**
 * 锁信息
 */
export interface LockInfo {
  id: string;
  timestamp: number;
  operation: string;
}
