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

    // Only create a ManifestManager when manifests are enabled
    if (!this.options.disableManifest) {
      this.manifestManager = new ManifestManager(fs, this.options.basePath);
    }
    
    this.dataDir = this.fsUtils.joinPath(this.options.basePath, DIRECTORIES.data);
    this.mergedDir = this.fsUtils.joinPath(this.options.basePath, DIRECTORIES.merged);
  }

  /**
   * 获取清单中记录的最后序列号
   */
  async getLastSequence(): Promise<number> {
    if (!this.manifestManager) return 0;
    return await this.manifestManager.getLastSequence();
  }

  /**
   * 初始化存储
   */
  async initialize(): Promise<void> {
    await this.fsUtils.ensureDir(this.options.basePath);
    await this.fsUtils.ensureDir(this.dataDir);
    await this.fsUtils.ensureDir(this.mergedDir);
  }

  /**
   * 写入文档批次
   */
  async writeDocuments(documents: StoredDocument[]): Promise<void> {
    if (documents.length === 0) return;
    // 只写入有变化的文档：先读取当前存储中已存在的最新版本进行比对
    const existing = this.manifestManager ? await this.readAllDocuments() : [];
    const existingMap = new Map<string, string | undefined>();
    for (const d of existing) {
      existingMap.set(d._id, d._rev);
    }

    // 过滤出比现有版本更新的文档
    const toWrite = documents.filter(doc => {
      const existingRev = existingMap.get(doc._id);
      if (!existingRev) return true; // 新文档
      if (!doc._rev) return true; // 没有 rev 的视为需要写入
      return this.isNewerRev(doc._rev, existingRev);
    });

    if (toWrite.length === 0) return;

    let sequence = await this.getLastSequence() + 1;
    const timestamp = Date.now();

    // 按文件大小限制分片
    const chunks = this.chunkDocuments(toWrite);
    
    for (const chunk of chunks) {
      const filename = this.generateDataFilename(sequence, timestamp);

      // 简化方案：新文件直接写入根目录，由重排机制统一整理到分区目录
      const filePath = this.fsUtils.joinPath(this.dataDir, filename);

      const content: DataFileContent = {
        version: STORAGE_VERSION,
        timestamp,
        sequence,
        documents: chunk,
      };

      await this.fsUtils.writeJSON(filePath, content);

      // 更新清单（不设置 partition 字段，表示文件在根目录）
      const metadata: DataFileMetadata = {
        filename,
        startSeq: sequence,
        endSeq: sequence,
        timestamp,
        documentCount: chunk.length,
        // partition 字段不设置，表示文件在根目录
      };

      if (this.manifestManager) {
        await this.manifestManager.addFile(metadata);
      }
      // 为下一个 chunk 递增序列号
      sequence++;
    }
  }

  /**
   * 读取所有文档（从最新到最旧）
   */
  async readAllDocuments(): Promise<StoredDocument[]> {
    if (!this.manifestManager) return [];
    const files = await this.manifestManager.getFiles();
    const documents: StoredDocument[] = [];
    const docMap = new Map<string, StoredDocument>();
    
    // 从最新文件开始读取，确保获取最新版本
    for (let i = files.length - 1; i >= 0; i--) {
      const file = files[i];
      const docs = await this.readDataFile(file);
      
      for (const doc of docs) {
        // 只保留每个文档的最新版本
        if (!docMap.has(doc._id)) {
          docMap.set(doc._id, doc);
        }
      }
    }
    
    return Array.from(docMap.values());
  }

  /**
   * 读取增量文档（从指定序列号开始）
   */
  async readIncrementalDocuments(fromSequence: number): Promise<StoredDocument[]> {
    if (!this.manifestManager) return [];
    const files = await this.manifestManager.getFiles();
    const documents: StoredDocument[] = [];
    const docMap = new Map<string, StoredDocument>();
    
    // 过滤出需要的文件
    const relevantFiles = files.filter(f => f.endSeq >= fromSequence);
    
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
    
    return Array.from(docMap.values());
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
      // 支持分区路径（如果有 partition 字段则从对应分区读取）
      const partition = (metadata as any).partition as string | undefined;
      if (partition) {
        filePath = this.fsUtils.joinPath(this.dataDir, partition, metadata.filename);
      } else {
        filePath = this.fsUtils.joinPath(this.dataDir, metadata.filename);
      }
    }
    
    try {
      const content = await this.fsUtils.readJSON<DataFileContent>(filePath);
      return content.documents;
    } catch (error) {
      console.error(`Failed to read file ${metadata.filename}:`, error);
      return [];
    }
  }

  /**
   * 合并多个数据文件
   */
  async mergeFiles(files: DataFileMetadata[]): Promise<DataFileMetadata> {
    if (files.length < 2) {
      throw new Error('Need at least 2 files to merge');
    }
    
    // 读取所有文件的文档
    const allDocuments: StoredDocument[] = [];
    for (const file of files) {
      const docs = await this.readDataFile(file);
      allDocuments.push(...docs);
    }
    
    // 去重，保留最新版本
    const docMap = new Map<string, StoredDocument>();
    for (const doc of allDocuments) {
      docMap.set(doc._id, doc);
    }
    
    const mergedDocuments = Array.from(docMap.values());
    
    // 生成合并文件名
    const startSeq = files[0].startSeq;
    const endSeq = files[files.length - 1].endSeq;
    const timestamp = Date.now();
    const filename = this.generateMergedFilename(startSeq, endSeq, timestamp);
    const filePath = this.fsUtils.joinPath(this.mergedDir, filename);
    
    // 写入合并文件
    const content: DataFileContent = {
      version: STORAGE_VERSION,
      timestamp,
      sequence: startSeq,
      documents: mergedDocuments,
      metadata: {
        filename,
        startSeq,
        endSeq,
        timestamp,
        documentCount: mergedDocuments.length,
        mergedFrom: files.map(f => f.filename),
      },
    };
    
    await this.fsUtils.writeJSON(filePath, content);
    
    // 更新清单中的文件元数据
    const mergedMetadata: DataFileMetadata = {
      filename,
      startSeq,
      endSeq,
      timestamp,
      documentCount: mergedDocuments.length,
      mergedFrom: files.map(f => f.filename),
    };
    
    // 删除旧文件的清单条目，添加新的合并文件条目
    if (this.manifestManager) {
      // 删除旧文件的清单条目，添加新的合并文件条目
      for (const file of files) {
        await this.manifestManager.updateFile(file.filename, {
          mergedFrom: ['archived'],
        });
      }
      await this.manifestManager.addFile(mergedMetadata);
    }
    
    return mergedMetadata;
  }

  /**
   * 获取可合并的文件组
   */
  async getMergeCandidates(): Promise<DataFileMetadata[][]> {
    if (!this.manifestManager) return [];
    return await this.manifestManager.getMergeCandidates(this.options.mergeThreshold);
  }

  /**
   * 将文档分片
   */
  private chunkDocuments(documents: StoredDocument[]): StoredDocument[][] {
    const chunks: StoredDocument[][] = [];
    let currentChunk: StoredDocument[] = [];
    let currentSize = 0;
    
    for (const doc of documents) {
      const docSize = JSON.stringify(doc).length;
      
      if (currentSize + docSize > this.options.maxFileSize && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = 0;
      }
      
      currentChunk.push(doc);
      currentSize += docSize;
    }
    
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }
    
    return chunks;
  }

  /**
   * 比较两个 rev 字符串，返回 rev1 是否比 rev2 新
   */
  private isNewerRev(rev1?: string, rev2?: string): boolean {
    if (!rev1 && !rev2) return false;
    if (!rev2) return true;
    if (!rev1) return false;

    const seq1 = parseInt(String(rev1).split('-')[0], 10) || 0;
    const seq2 = parseInt(String(rev2).split('-')[0], 10) || 0;
    return seq1 > seq2;
  }

  /**
   * 生成数据文件名
   */
  private generateDataFilename(sequence: number, timestamp: number): string {
    return `data-${sequence}-${formatTimestamp(timestamp)}.json`;
  }

  /**
   * 生成合并文件名
   */
  private generateMergedFilename(startSeq: number, endSeq: number, timestamp: number): string {
    return `merged-${startSeq}-${endSeq}-${formatTimestamp(timestamp)}.json`;
  }

  // ==================== 目录重排功能 ====================

  /**
   * 检查是否需要重排
   */
  async shouldReorganize(): Promise<boolean> {
    const stats = await this.getDirectoryStats();
    return stats.some(s => s.needsReorganization);
  }

  /**
   * 获取目录统计信息
   */
  async getDirectoryStats(): Promise<DirectoryStats[]> {
    const stats: DirectoryStats[] = [];
    const threshold = this.options.maxFilesPerDirectory;

    // 检查 data 目录
    const dataStats = await this.getSingleDirStats(this.dataDir, threshold);
    stats.push(...dataStats);

    // 检查 merged 目录
    const mergedStats = await this.getSingleDirStats(this.mergedDir, threshold);
    stats.push(...mergedStats);

    return stats;
  }

  /**
   * 获取单个目录的统计信息（递归检查子目录）
   */
  private async getSingleDirStats(dirPath: string, threshold: number): Promise<DirectoryStats[]> {
    const stats: DirectoryStats[] = [];
    
    try {
      const entries = await this.fs.readdir(dirPath);
      let fileCount = 0;
      let totalSize = 0;
      const subDirs: string[] = [];

      for (const entry of entries) {
        const entryPath = this.fsUtils.joinPath(dirPath, entry);
        try {
          const stat = await this.fs.stat(entryPath);
          if (stat.isFile() && entry.endsWith('.json')) {
            fileCount++;
            // 估算文件大小（通过读取文件）
            try {
              const content = await this.fs.readFile(entryPath, 'utf8');
              totalSize += content.length;
            } catch {
              // 忽略读取错误
            }
          } else if (stat.isDirectory()) {
            subDirs.push(entryPath);
          }
        } catch {
          // 忽略统计错误
        }
      }

      // 添加当前目录统计
      stats.push({
        path: dirPath,
        fileCount,
        totalSize,
        needsReorganization: fileCount > threshold,
      });

      // 递归检查子目录
      for (const subDir of subDirs) {
        const subStats = await this.getSingleDirStats(subDir, threshold);
        stats.push(...subStats);
      }
    } catch {
      // 目录不存在或无法读取
    }

    return stats;
  }

  /**
   * 扫描需要重排的目录
   */
  private async scanDirectoriesForReorg(): Promise<ReorgCandidate[]> {
    const candidates: ReorgCandidate[] = [];
    const threshold = this.options.reorgThreshold;

    // 扫描 data 目录
    const dataCandidates = await this.scanDirForReorg(this.dataDir, threshold);
    candidates.push(...dataCandidates);

    // 扫描 merged 目录
    const mergedCandidates = await this.scanDirForReorg(this.mergedDir, threshold);
    candidates.push(...mergedCandidates);

    return candidates;
  }

  /**
   * 扫描单个目录获取重排候选
   */
  private async scanDirForReorg(dirPath: string, threshold: number): Promise<ReorgCandidate[]> {
    const candidates: ReorgCandidate[] = [];

    try {
      const entries = await this.fs.readdir(dirPath);
      const jsonFiles: string[] = [];
      const subDirs: string[] = [];

      for (const entry of entries) {
        const entryPath = this.fsUtils.joinPath(dirPath, entry);
        try {
          const stat = await this.fs.stat(entryPath);
          if (stat.isFile() && entry.endsWith('.json') && !entry.includes('manifest')) {
            jsonFiles.push(entry);
          } else if (stat.isDirectory()) {
            subDirs.push(entryPath);
          }
        } catch {
          // 忽略错误
        }
      }

      // 如果当前目录文件数超过阈值，添加为候选
      if (jsonFiles.length > threshold) {
        candidates.push({
          path: dirPath,
          fileCount: jsonFiles.length,
          files: jsonFiles,
        });
      }

      // 递归检查子目录
      for (const subDir of subDirs) {
        const subCandidates = await this.scanDirForReorg(subDir, threshold);
        candidates.push(...subCandidates);
      }
    } catch {
      // 目录不存在
    }

    return candidates;
  }

  /**
   * 执行目录重排
   */
  async reorganize(options: ReorgOptions = {}): Promise<ReorgResult> {
    const result: ReorgResult = {
      movedFiles: 0,
      failedFiles: 0,
      errors: [],
    };

    if (!this.manifestManager) {
      result.errors.push(new Error('Manifest is disabled'));
      return result;
    }

    const dryRun = options.dryRun ?? false;
    const batchSize = options.batchSize ?? this.options.reorgBatchSize;

    // 扫描需要重排的目录
    const candidates = options.targetDir 
      ? await this.scanDirForReorg(options.targetDir, this.options.reorgThreshold)
      : await this.scanDirectoriesForReorg();

    if (candidates.length === 0) {
      return result;
    }

    // 获取所有文件元数据
    const allFiles = await this.manifestManager.getFiles();

    for (const candidate of candidates) {
      // 按时间排序，优先移动较旧的文件
      const filesToMove = candidate.files
        .map(filename => allFiles.find(f => f.filename === filename || f.filename.endsWith(filename)))
        .filter((f): f is DataFileMetadata => f !== undefined)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, batchSize);

      for (const file of filesToMove) {
        try {
          // 确定目标分区
          const date = new Date(file.timestamp);
          const year = String(date.getUTCFullYear());
          const month = String(date.getUTCMonth() + 1).padStart(2, '0');
          const targetPartition = `${year}/${month}`;

          // 检查是否已经在正确的位置
          const currentPartition = (file as any).partition as string | undefined;
          if (currentPartition === targetPartition) {
            continue; // 已经在正确位置，跳过
          }

          // 构建路径
          const isMergedFile = file.mergedFrom !== undefined;
          const baseDir = isMergedFile ? this.mergedDir : this.dataDir;
          const sourcePath = currentPartition 
            ? this.fsUtils.joinPath(baseDir, currentPartition, file.filename)
            : this.fsUtils.joinPath(baseDir, file.filename);
          
          const targetDir = this.fsUtils.joinPath(baseDir, targetPartition);
          const targetPath = this.fsUtils.joinPath(targetDir, file.filename);

          if (dryRun) {
            console.log(`[DRY RUN] Would move: ${sourcePath} -> ${targetPath}`);
            result.movedFiles++;
            continue;
          }

          // 确保目标目录存在
          await this.fsUtils.ensureDir(targetDir);

          // 读取文件内容
          const content = await this.fsUtils.readJSON<DataFileContent>(sourcePath);

          // 写入新位置
          await this.fsUtils.writeJSON(targetPath, content);

          // 更新 manifest
          await this.manifestManager.updateFile(file.filename, {
            partition: targetPartition,
          });

          // 删除原文件
          try {
            await this.fs.unlink(sourcePath);
          } catch (error) {
            console.warn(`Failed to delete source file ${sourcePath}:`, error);
          }

          result.movedFiles++;
          console.log(`Reorganized: ${file.filename} -> ${targetPartition}`);
        } catch (error) {
          result.failedFiles++;
          result.errors.push(new Error(`Failed to reorganize ${file.filename}: ${error}`));
          console.error(`Failed to reorganize ${file.filename}:`, error);
        }
      }
    }

    return result;
  }
}
