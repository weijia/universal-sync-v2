import {
  IFileSystem,
  DataFileContent,
  DataFileMetadata,
  StoredDocument,
  SyncOptions,
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
  private manifestManager: ManifestManager;
  private dataDir: string;
  private mergedDir: string;
  private options: Required<SyncOptions>;

  constructor(
    private fs: IFileSystem,
    options: SyncOptions
  ) {
    this.fsUtils = new FileSystemUtils(fs);
    this.manifestManager = new ManifestManager(fs, options.basePath);
    
    this.options = {
      ...DEFAULT_CONFIG,
      ...options,
    } as Required<SyncOptions>;
    
    this.dataDir = this.fsUtils.joinPath(this.options.basePath, DIRECTORIES.data);
    this.mergedDir = this.fsUtils.joinPath(this.options.basePath, DIRECTORIES.merged);
  }

  /**
   * 获取清单中记录的最后序列号
   */
  async getLastSequence(): Promise<number> {
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
    
  let sequence = await this.manifestManager.getLastSequence() + 1;
  const timestamp = Date.now();
    
    // 按文件大小限制分片
    const chunks = this.chunkDocuments(documents);
    
    for (const chunk of chunks) {
      const filename = this.generateDataFilename(sequence, timestamp);
      const filePath = this.fsUtils.joinPath(this.dataDir, filename);
      
      const content: DataFileContent = {
        version: STORAGE_VERSION,
        timestamp,
        sequence,
        documents: chunk,
      };
      
      await this.fsUtils.writeJSON(filePath, content);
      
      // 更新清单
      const metadata: DataFileMetadata = {
        filename,
        startSeq: sequence,
        endSeq: sequence,
        timestamp,
        documentCount: chunk.length,
      };
      
      await this.manifestManager.addFile(metadata);
      // 为下一个 chunk 递增序列号
      sequence++;
    }
  }

  /**
   * 读取所有文档（从最新到最旧）
   */
  async readAllDocuments(): Promise<StoredDocument[]> {
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
      filePath = this.fsUtils.joinPath(this.dataDir, metadata.filename);
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
    for (const file of files) {
      await this.manifestManager.updateFile(file.filename, {
        mergedFrom: ['archived'],
      });
    }
    
    await this.manifestManager.addFile(mergedMetadata);
    
    return mergedMetadata;
  }

  /**
   * 获取可合并的文件组
   */
  async getMergeCandidates(): Promise<DataFileMetadata[][]> {
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
}
