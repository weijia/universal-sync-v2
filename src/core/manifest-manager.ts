import { IFileSystem, ManifestContent, DataFileMetadata } from '../types.js';
import { FileSystemUtils } from '../utils/fs-utils.js';
import { STORAGE_VERSION, FILE_PATTERNS } from '../constants.js';

/**
 * 清单文件管理器
 * 负责维护数据文件的元数据清单
 */
export class ManifestManager {
  private fsUtils: FileSystemUtils;
  private manifestPath: string;

  constructor(
    private fs: IFileSystem,
    private basePath: string
  ) {
    this.fsUtils = new FileSystemUtils(fs);
    this.manifestPath = this.fsUtils.joinPath(basePath, FILE_PATTERNS.manifest);
  }

  /**
   * 读取清单
   */
  async readManifest(): Promise<ManifestContent> {
    try {
      const exists = await this.fsUtils.fileExists(this.manifestPath);
      
      if (!exists) {
        return this.createEmptyManifest();
      }
      
      return await this.fsUtils.readJSON<ManifestContent>(this.manifestPath);
    } catch (error) {
      // 清单文件损坏，重建
      return this.createEmptyManifest();
    }
  }

  /**
   * 写入清单（原子性）
   */
  async writeManifest(manifest: ManifestContent): Promise<void> {
    await this.fsUtils.atomicWrite(this.manifestPath, manifest);
  }

  /**
   * 添加数据文件到清单
   */
  async addFile(metadata: DataFileMetadata): Promise<void> {
    const manifest = await this.readManifest();
    
    // 更新序列号和时间戳
    if (metadata.endSeq > manifest.lastSequence) {
      manifest.lastSequence = metadata.endSeq;
    }
    
    if (metadata.timestamp > manifest.lastTimestamp) {
      manifest.lastTimestamp = metadata.timestamp;
    }
    
    // 添加文件元数据
    manifest.files.push(metadata);
    
    // 按序列号排序
    manifest.files.sort((a, b) => a.startSeq - b.startSeq);
    
    await this.writeManifest(manifest);
  }

  /**
   * 更新文件元数据（用于合并后）
   */
  async updateFile(filename: string, metadata: Partial<DataFileMetadata>): Promise<void> {
    const manifest = await this.readManifest();
    
    const fileIndex = manifest.files.findIndex(f => f.filename === filename);
    if (fileIndex !== -1) {
      manifest.files[fileIndex] = {
        ...manifest.files[fileIndex],
        ...metadata,
      };
      
      await this.writeManifest(manifest);
    }
  }

  /**
   * 获取所有数据文件（按序列号排序）
   */
  async getFiles(): Promise<DataFileMetadata[]> {
    const manifest = await this.readManifest();
    return [...manifest.files];
  }

  /**
   * 获取最新的序列号
   */
  async getLastSequence(): Promise<number> {
    const manifest = await this.readManifest();
    return manifest.lastSequence;
  }

  /**
   * 获取可合并的文件
   * @param threshold 文件大小阈值
   */
  async getMergeCandidates(threshold: number): Promise<DataFileMetadata[][]> {
    const manifest = await this.readManifest();
    const candidates: DataFileMetadata[][] = [];
    let currentGroup: DataFileMetadata[] = [];
    let groupSize = 0;
    
    for (const file of manifest.files) {
      // 跳过已经合并的文件
      if (file.mergedFrom) {
        if (currentGroup.length > 1) {
          candidates.push(currentGroup);
        }
        currentGroup = [];
        groupSize = 0;
        continue;
      }
      
      // 检查文件大小（这里简化处理，实际应该读取文件）
      const estimatedSize = file.documentCount * 1000; // 估算
      
      if (estimatedSize < threshold) {
        currentGroup.push(file);
        groupSize += estimatedSize;
        
        // 如果组大小超过阈值，保存这个组
        if (groupSize >= threshold && currentGroup.length > 1) {
          candidates.push(currentGroup);
          currentGroup = [];
          groupSize = 0;
        }
      } else {
        // 当前文件太大，不需要合并
        if (currentGroup.length > 1) {
          candidates.push(currentGroup);
        }
        currentGroup = [];
        groupSize = 0;
      }
    }
    
    // 保存最后一组
    if (currentGroup.length > 1) {
      candidates.push(currentGroup);
    }
    
    return candidates;
  }

  /**
   * 创建空清单
   */
  private createEmptyManifest(): ManifestContent {
    return {
      version: STORAGE_VERSION,
      lastSequence: 0,
      lastTimestamp: Date.now(),
      files: [],
    };
  }
}
