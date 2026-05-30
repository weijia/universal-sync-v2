import {
  IFileSystem,
  DataFileContent,
  DataFileMetadata,
  StoredDocument,
  SyncOptions,
  ReorgOptions,
  ReorgResult,
  DirectoryStats,
  ReorgCandidate,
} from '../types.js';
import { FileSystemUtils } from '../utils/fs-utils.js';
import { ManifestManager } from './manifest-manager.js';
import { STORAGE_VERSION, DIRECTORIES, DEFAULT_CONFIG } from '../constants.js';
import { formatTimestamp } from '../utils/helpers.js';

// 调试开关
const DEBUG = typeof process !== 'undefined' ? process.env.DEBUG === 'true' : true;
const PREFIX = '[StorageManager]';

function debug(...args: any[]) {
  if (DEBUG) {
    console.log(PREFIX, ...args);
  }
}

function debugError(...args: any[]) {
  console.error(PREFIX, ...args);
}

/**
 * 存储管理器
 * 负责数据文件的读写和分片管理
 */
export class StorageManager {
  private fsUtils: FileSystemUtils;
  private manifestManager?: ManifestManager;
  private dataDir: string;
  private mergedDir: string;
  private options: Required<SyncOptions>;

  constructor(
    private fs: IFileSystem,
    options: SyncOptions
  ) {
    this.fsUtils = new FileSystemUtils(fs);
    this.options = {
      ...DEFAULT_CONFIG,
      ...options,
    } as Required<SyncOptions>;

    debug('构造函数, basePath:', options.basePath, 'dataDir:', this.fsUtils.joinPath(options.basePath, DIRECTORIES.data));

    if (!this.options.disableManifest) {
      this.manifestManager = new ManifestManager(fs, this.options.basePath);
    }
    
    this.dataDir = this.fsUtils.joinPath(this.options.basePath, DIRECTORIES.data);
    this.mergedDir = this.fsUtils.joinPath(this.options.basePath, DIRECTORIES.merged);
  }

  /**
   * 初始化存储目录
   */
  async initialize(): Promise<void> {
    debug('初始化存储目录...');
    await this.fsUtils.ensureDir(this.options.basePath);
    await this.fsUtils.ensureDir(this.dataDir);
    await this.fsUtils.ensureDir(this.mergedDir);
    debug('存储目录初始化完成');
  }

  /**
   * 获取清单中记录的最后序列号
   */
  async getLastSequence(): Promise<number> {
    if (!this.manifestManager) return 0;
    const manifest = await this.manifestManager.readManifest();
    debug('getLastSequence:', manifest.lastSequence);
    return manifest.lastSequence;
  }

  /**
   * 写入文档批次
   */
  async writeDocuments(documents: StoredDocument[]): Promise<void> {
    debug('writeDocuments() 开始, 文档数量:', documents.length);
    
    if (documents.length === 0) {
      debug('没有文档需要写入');
      return;
    }

    // 按序列号排序
    const sortedDocs = [...documents].sort((a, b) => {
      const seqA = parseInt((a as any)._rev?.split('-')[0] || '0', 10);
      const seqB = parseInt((b as any)._rev?.split('-')[0] || '0', 10);
      return seqA - seqB;
    });

    const timestamp = Date.now();
    const chunkSize = this.options.maxFileSize / 500; // 估算每条记录大小
    const docsPerChunk = Math.floor(chunkSize) || 100;
    
    debug('每块文档数量:', docsPerChunk);

    let sequence = (await this.getLastSequence()) + 1;
    
    while (sortedDocs.length > 0) {
      const chunk = sortedDocs.splice(0, docsPerChunk);
      const endSeq = sequence + chunk.length - 1;
      const filename = `data-${sequence}-${endSeq}-${timestamp}.json`;
      
      debug(`写入文件: ${filename}, 序列: ${sequence}-${endSeq}, 文档数: ${chunk.length}`);
      
      await this.writeDataFile(filename, chunk, sequence, endSeq, timestamp);
      
      // 更新清单
      await this.manifestManager?.addFile({
        filename,
        startSeq: sequence,
        endSeq,
        timestamp,
        documentCount: chunk.length,
      });
      
      sequence = endSeq + 1;
    }
    
    debug('writeDocuments() 完成');
  }

  private async writeDataFile(
    filename: string,
    documents: StoredDocument[],
    startSeq: number,
    endSeq: number,
    timestamp: number
  ): Promise<void> {
    const filePath = this.fsUtils.joinPath(this.dataDir, filename);
    debug(`writeDataFile: ${filePath}, 文档数: ${documents.length}`);
    
    const content: DataFileContent = {
      version: STORAGE_VERSION,
      timestamp,
      sequence: endSeq,
      documents,
    };
    
    try {
      await this.fsUtils.atomicWrite(filePath, content);
      debug(`文件写入成功: ${filename}`);
    } catch (error) {
      debugError(`文件写入失败: ${filename}`, error);
      throw error;
    }
  }

  /**
   * 读取所有文档（从最新到最旧）
   */
  async readAllDocuments(): Promise<StoredDocument[]> {
    debug('readAllDocuments() 开始');
    
    if (!this.manifestManager) {
      debug('没有 manifestManager，返回空数组');
      return [];
    }
    
    const files = await this.manifestManager.getFiles();
    debug('清单中的文件数量:', files.length);
    debug('文件列表:', files.map(f => ({ filename: f.filename, startSeq: f.startSeq, endSeq: f.endSeq, partition: (f as any).partition })));
    
    const documents: StoredDocument[] = [];
    const docMap = new Map<string, StoredDocument>();
    
    // 从最新文件开始读取，确保获取最新版本
    for (let i = files.length - 1; i >= 0; i--) {
      const file = files[i];
      debug(`读取文件 ${i}/${files.length}: ${file.filename}`);
      const docs = await this.readDataFile(file);
      debug(`  文件 ${file.filename} 包含 ${docs.length} 条文档`);
      
      for (const doc of docs) {
        if (!docMap.has(doc._id)) {
          docMap.set(doc._id, doc);
        }
      }
    }
    
    const result = Array.from(docMap.values());
    debug(`readAllDocuments() 完成，共 ${result.length} 条文档`);
    return result;
  }

  /**
   * 读取增量文档（从指定序列号开始）
   */
  async readIncrementalDocuments(fromSequence: number): Promise<StoredDocument[]> {
    debug('readIncrementalDocuments() 开始, fromSequence:', fromSequence);
    
    if (!this.manifestManager) {
      debug('没有 manifestManager，返回空数组');
      return [];
    }
    
    const files = await this.manifestManager.getFiles();
    const documents: StoredDocument[] = [];
    const docMap = new Map<string, StoredDocument>();
    
    // 过滤出需要的文件
    const relevantFiles = files.filter(f => f.endSeq >= fromSequence);
    debug('相关文件数量:', relevantFiles.length);
    
    // 从最新文件开始读取
    for (let i = relevantFiles.length - 1; i >= 0; i--) {
      const file = relevantFiles[i];
      const docs = await this.readDataFile(file);
      
      for (const doc of docs) {
        if (!docMap.has(doc._id)) {
          docMap.set(doc._id, doc);
        }
      }
    }
    
    const result = Array.from(docMap.values());
    debug(`readIncrementalDocuments() 完成，共 ${result.length} 条文档`);
    return result;
  }

  /**
   * 读取数据文件
   */
  private async readDataFile(metadata: DataFileMetadata): Promise<StoredDocument[]> {
    let filePath: string;
    
    // 优先使用合并文件
    if (metadata.mergedFrom) {
      filePath = this.fsUtils.joinPath(this.mergedDir, metadata.filename);
    } else {
      const partition = (metadata as any).partition as string | undefined;
      if (partition) {
        // filename 可能是 "data-1-2-xxx.json"（不含前缀）或 "data/2026/05/data-1-2-xxx.json"（含前缀）
        if (metadata.filename.startsWith(DIRECTORIES.data + '/')) {
          // 已经包含 data/ 前缀，直接拼接 basePath
          filePath = this.fsUtils.joinPath(this.options.basePath, metadata.filename);
        } else {
          filePath = this.fsUtils.joinPath(this.dataDir, partition, metadata.filename);
        }
      } else {
        // 无分区：filename 可能是 "data-1-2-xxx.json"
        // 但如果 filename 以 "data/" 开头，说明是带分区路径的
        if (metadata.filename.startsWith(DIRECTORIES.data + '/')) {
          filePath = this.fsUtils.joinPath(this.options.basePath, metadata.filename);
        } else {
          filePath = this.fsUtils.joinPath(this.dataDir, metadata.filename);
        }
      }
    }
    
    debug(`readDataFile: ${filePath}`);
    
    try {
      const content = await this.fsUtils.readJSON<DataFileContent>(filePath);
      debug(`  读取成功，文件包含 ${content.documents?.length || 0} 条文档`);
      
      if (!content.documents) {
        debugError('  文件格式错误：没有 documents 字段');
        return [];
      }
      
      return content.documents;
    } catch (error) {
      debugError(`读取文件失败 ${metadata.filename}:`, error);
      return [];
    }
  }

  /**
   * 合并多个数据文件
   */
  async mergeFiles(files: DataFileMetadata[]): Promise<DataFileMetadata> {
    if (files.length < 2) {
      throw new Error('需要至少 2 个文件才能合并');
    }
    
    debug('mergeFiles: 合并', files.length, '个文件');
    
    const allDocuments: StoredDocument[] = [];
    for (const file of files) {
      const docs = await this.readDataFile(file);
      allDocuments.push(...docs);
    }
    
    // 合并后文件元数据
    const timestamp = Date.now();
    const startSeq = Math.min(...files.map(f => f.startSeq));
    const endSeq = Math.max(...files.map(f => f.endSeq));
    const filename = `merged-${startSeq}-${endSeq}-${timestamp}.json`;
    
    const mergedFile: DataFileMetadata = {
      filename,
      startSeq,
      endSeq,
      timestamp,
      documentCount: allDocuments.length,
      mergedFrom: files.map(f => f.filename),
    };
    
    const filePath = this.fsUtils.joinPath(this.mergedDir, filename);
    const content: DataFileContent = {
      version: STORAGE_VERSION,
      timestamp,
      sequence: endSeq,
      documents: allDocuments,
    };
    
    await this.fsUtils.atomicWrite(filePath, content);
    
    // 删除原文件
    for (const file of files) {
      let oldPath: string;
      if (file.filename.startsWith(DIRECTORIES.data + '/')) {
        oldPath = this.fsUtils.joinPath(this.options.basePath, file.filename);
      } else {
        oldPath = this.fsUtils.joinPath(this.dataDir, file.filename);
      }
      try {
        await this.fs.unlink(oldPath);
      } catch {
        // ignore
      }
    }
    
    return mergedFile;
  }

  /**
   * 获取合并候选文件
   */
  async getMergeCandidates(): Promise<DataFileMetadata[][]> {
    // 实现简化版合并策略
    return [];
  }

  /**
   * 获取目录统计信息
   */
  async getDirectoryStats(threshold: number = 100): Promise<DirectoryStats[]> {
    debug('getDirectoryStats() 开始, threshold:', threshold);
    const stats: DirectoryStats[] = [];

    // 统计 data 根目录下的文件数（不含子目录中的文件）
    const dataDirFiles = await this.getRootDataFiles();
    if (dataDirFiles.length > 0) {
      stats.push({
        path: this.dataDir,
        fileCount: dataDirFiles.length,
        totalSize: 0, // 不计算大小以减少 I/O
        needsReorganization: dataDirFiles.length >= threshold,
      });
    }

    // 统计 merged 根目录下的文件数
    const mergedDirFiles = await this.getRootMergedFiles();
    if (mergedDirFiles.length > 0) {
      stats.push({
        path: this.mergedDir,
        fileCount: mergedDirFiles.length,
        totalSize: 0,
        needsReorganization: mergedDirFiles.length >= threshold,
      });
    }

    debug('getDirectoryStats() 完成:', stats);
    return stats;
  }

  /**
   * 检查是否需要重组
   */
  async shouldReorganize(): Promise<boolean> {
    const threshold = this.options.reorgThreshold || 100;
    const stats = await this.getDirectoryStats(threshold);
    const needsReorg = stats.some(s => s.needsReorganization);
    debug('shouldReorganize():', needsReorg, '(threshold:', threshold, ')');
    return needsReorg;
  }

  /**
   * 执行目录重组
   * 将 data/ 和 merged/ 根目录下的文件按时间戳移动到 YYYY/MM/ 分区目录
   */
  async reorganize(options?: ReorgOptions): Promise<ReorgResult> {
    debug('reorganize() 开始, options:', options);
    const result: ReorgResult = { movedFiles: 0, failedFiles: 0, errors: [] };
    const batchSize = options?.batchSize || this.options.reorgBatchSize || 50;

    // 收集需要移动的文件（data 根目录下的文件）
    const dataFiles = await this.getRootDataFiles();
    const mergedFiles = await this.getRootMergedFiles();

    // 合并并按时间排序（优先移动较旧的文件）
    const allFiles: { dir: string; filename: string; timestamp: number }[] = [];
    for (const filename of dataFiles) {
      const ts = this.extractTimestampFromFilename(filename);
      allFiles.push({ dir: 'data', filename, timestamp: ts });
    }
    for (const filename of mergedFiles) {
      const ts = this.extractTimestampFromFilename(filename);
      allFiles.push({ dir: 'merged', filename, timestamp: ts });
    }
    allFiles.sort((a, b) => a.timestamp - b.timestamp);

    if (allFiles.length === 0) {
      debug('reorganize() 完成: 没有需要移动的文件');
      return result;
    }

    // 限制批次大小
    const toProcess = allFiles.slice(0, batchSize);
    debug('本次处理文件数:', toProcess.length, '/ 总数:', allFiles.length);

    if (options?.dryRun) {
      debug('dryRun 模式，不实际移动文件');
      result.movedFiles = toProcess.length;
      return result;
    }

    for (const item of toProcess) {
      try {
        await this.moveFileToPartition(item.dir, item.filename);
        result.movedFiles++;
        debug(`移动成功: ${item.dir}/${item.filename}`);
      } catch (error) {
        result.failedFiles++;
        result.errors.push(error instanceof Error ? error : new Error(String(error)));
        debugError(`移动失败: ${item.dir}/${item.filename}`, error);
      }
    }

    debug('reorganize() 完成:', result);
    return result;
  }

  /**
   * 重组目录结构（别名，与 reorganize 行为一致）
   */
  async reorganizeToPartitions(): Promise<void> {
    await this.reorganize();
  }

  // ─── 重组辅助方法 ───

  /**
   * 获取 data 根目录下的文件（排除子目录中的文件和 manifest）
   */
  private async getRootDataFiles(): Promise<string[]> {
    const allFiles = await this.fsUtils.listFiles(this.dataDir, /^data-.*\.json$/);
    return allFiles;
  }

  /**
   * 获取 merged 根目录下的文件（排除子目录中的文件）
   */
  private async getRootMergedFiles(): Promise<string[]> {
    const allFiles = await this.fsUtils.listFiles(this.mergedDir, /^merged-.*\.json$/);
    return allFiles;
  }

  /**
   * 从文件名中提取时间戳
   * 文件名格式: data-{startSeq}-{endSeq}-{timestamp}.json
   */
  private extractTimestampFromFilename(filename: string): number {
    const parts = filename.replace('.json', '').split('-');
    // timestamp 是最后一段
    const ts = parseInt(parts[parts.length - 1], 10);
    return isNaN(ts) ? 0 : ts;
  }

  /**
   * 将单个文件移动到按时间分区的目录
   * 目标路径: {dir}/YYYY/MM/{filename}
   *
   * 安全策略：
   * 1. 读取原文件内容
   * 2. 写入新位置
   * 3. 更新 manifest（将 partition 字段写入）
   * 4. 验证 manifest 更新成功
   * 5. 删除原文件
   * 如果步骤 3-4 失败，删除新位置的文件（回滚）
   */
  private async moveFileToPartition(dir: string, filename: string): Promise<void> {
    const isDataDir = dir === 'data';
    const baseDir = isDataDir ? this.dataDir : this.mergedDir;
    const oldPath = this.fsUtils.joinPath(baseDir, filename);

    // 1. 读取原文件内容
    const content = await this.fsUtils.readJSON<DataFileContent>(oldPath);

    // 2. 计算目标分区路径 YYYY/MM
    const date = new Date(content.timestamp);
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const partition = `${year}/${month}`;
    const partitionDir = this.fsUtils.joinPath(baseDir, partition);

    // 3. 确保目标目录存在
    await this.fsUtils.ensureDir(partitionDir);

    // 4. 写入新位置
    const newPath = this.fsUtils.joinPath(partitionDir, filename);
    await this.fsUtils.atomicWrite(newPath, content);

    // 5. 更新 manifest
    try {
      if (this.manifestManager) {
        // 从 manifest 中找到该文件并更新 partition 字段
        const files = await this.manifestManager.getFiles();
        const fileMeta = files.find(f => {
          // 匹配：filename 相同，或者 filename 包含完整路径
          return f.filename === filename ||
            f.filename === this.fsUtils.joinPath(dir, filename);
        });

        if (fileMeta) {
          const newFilename = this.fsUtils.joinPath(dir, partition, filename);
          await this.manifestManager.updateFile(fileMeta.filename, {
            filename: newFilename,
            partition,
          } as any);
        }
      }

      // 6. 验证新文件可读
      await this.fsUtils.readJSON<DataFileContent>(newPath);

      // 7. 删除原文件
      await this.fs.unlink(oldPath);
    } catch (error) {
      // 回滚：删除新位置的文件
      debugError(`manifest 更新失败，回滚: ${filename}`, error);
      try {
        await this.fs.unlink(newPath);
      } catch {
        // 忽略删除失败
      }
      throw error;
    }
  }
}
