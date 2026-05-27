/**
 * 版本号常量
 */
export const STORAGE_VERSION = '2.0.0';

/**
 * 默认配置
 */
export const DEFAULT_CONFIG = {
  maxFileSize: 1024 * 1024, // 1MB
  maxFilesPerDirectory: 1000,
  mergeThreshold: 100 * 1024, // 100KB
  mergeInterval: 60000, // 60秒
  autoMerge: true,
  // 目录重排默认配置
  reorgThreshold: 100, // 触发重排的文件数阈值
  reorgBatchSize: 50, // 每次重排最大文件数
  autoReorganize: true, // 是否自动重排
};

/**
 * 文件名模式
 */
export const FILE_PATTERNS = {
  manifest: 'manifest.json',
  manifestIndex: 'manifest-index.json',
  data: 'data-{sequence}-{timestamp}.json',
  merged: 'merged-{startSeq}-{endSeq}-{timestamp}.json',
  lock: '.lock',
};

/**
 * 目录结构
 */
export const DIRECTORIES = {
  data: 'data',
  merged: 'merged',
};
