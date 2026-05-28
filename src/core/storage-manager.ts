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
        filePath = this.fsUtils.joinPath(this.dataDir, partition, metadata.filename);
      } else {
        filePath = this.fsUtils.joinPath(this.dataDir, metadata.filename);
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
      const oldPath = this.fsUtils.joinPath(this.dataDir, file.filename);
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
   * 检查是否需要重组
   */
  async shouldReorganize(): Promise<boolean> {
    return false;
  }

  /**
   * 执行目录重组
   */
  async reorganize(): Promise<ReorgResult> {
    return { movedFiles: 0, failedFiles: 0, errors: [] };
  }

  /**
   * 获取目录统计信息
   */
  async getDirectoryStats(threshold: number = 100): Promise<DirectoryStats[]> {
    return [];
  }

  /**
   * 重组目录结构
   */
  async reorganizeToPartitions(): Promise<void> {
    // 实现按时间分区重组
  }
}
