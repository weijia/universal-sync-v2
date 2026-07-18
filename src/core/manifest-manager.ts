import { IFileSystem, ManifestContent, DataFileMetadata } from '../types.js';
import { FileSystemUtils } from '../utils/fs-utils.js';
import { STORAGE_VERSION, FILE_PATTERNS, DIRECTORIES } from '../constants.js';

/**
 * 清单文件管理器
 * 负责维护数据文件的元数据清单
 */
export class ManifestManager {
  private fsUtils: FileSystemUtils;
  private manifestPath: string;
  private manifestIndexPath: string;

  constructor(
    private fs: IFileSystem,
    private basePath: string
  ) {
    this.fsUtils = new FileSystemUtils(fs);
    this.manifestPath = this.fsUtils.joinPath(basePath, FILE_PATTERNS.manifest);
    this.manifestIndexPath = this.fsUtils.joinPath(basePath, FILE_PATTERNS.manifestIndex);
  }

  /**
   * 读取清单
   */
  async readManifest(): Promise<ManifestContent> {
    try {
      // 如果存在 manifest-index，则合并多个分区清单
      const indexExists = await this.fsUtils.fileExists(this.manifestIndexPath);
      if (indexExists) {
        try {
          const index = await this.fsUtils.readJSON<any>(this.manifestIndexPath);
          const combined: ManifestContent = this.createEmptyManifest();
          combined.files = [];
          combined.lastSequence = 0;
          combined.lastTimestamp = 0;

          // 读取每个分区的清单
          for (const partition of Object.keys(index.partitions || {})) {
            const p = index.partitions[partition];
            try {
              // 分区 manifest 存放在 data/<partition>/manifest.json
              const manifestPath = this.fsUtils.joinPath(this.basePath, DIRECTORIES.data, partition, FILE_PATTERNS.manifest);
              const pm = await this.fsUtils.readJSON<ManifestContent>(manifestPath);
              // 标记每个文件的 partition（便于后续读取）
              for (const f of pm.files) {
                f.partition = partition;
                // 兼容处理：确保分区 manifest 中的 filename 包含 data/ 前缀和分区路径
                try {
                  const fn = String((f as any).filename || '');
                  if (!fn.startsWith(DIRECTORIES.data)) {
                    (f as any).filename = this.fsUtils.joinPath(DIRECTORIES.data, partition, fn);
                  }
                } catch (e) {
                  // ignore
                }
                combined.files.push(f);
              }

              if (pm.lastSequence > combined.lastSequence) combined.lastSequence = pm.lastSequence;
              if (pm.lastTimestamp > combined.lastTimestamp) combined.lastTimestamp = pm.lastTimestamp;
            } catch (e) {
              // 忽略分区损坏，继续
              continue;
            }
          }

          // 如果根 manifest 存在，也将其合并（向后兼容）
          const rootExists = await this.fsUtils.fileExists(this.manifestPath);
          if (rootExists) {
            try {
              const rm = await this.fsUtils.readJSON<ManifestContent>(this.manifestPath);
              for (const f of rm.files) {
                combined.files.push(f);
              }
              if (rm.lastSequence > combined.lastSequence) combined.lastSequence = rm.lastSequence;
              if (rm.lastTimestamp > combined.lastTimestamp) combined.lastTimestamp = rm.lastTimestamp;
            } catch (e) {
              // ignore
            }
          }

          // 按序号排序
          combined.files.sort((a, b) => a.startSeq - b.startSeq);
          return combined;
        } catch (e) {
          return this.createEmptyManifest();
        }
      }

      const exists = await this.fsUtils.fileExists(this.manifestPath);
      if (!exists) {
        return this.createEmptyManifest();
      }
      return await this.fsUtils.readJSON<ManifestContent>(this.manifestPath);
    } catch (error) {
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
    // 如果 metadata 包含 partition，则写入分区清单并更新 manifest-index
    if ((metadata as any).partition) {
      const partition = (metadata as any).partition as string;
      // 分区 manifest 存放在 data/<partition>/manifest.json，并确保 data/<partition> 目录存在
      const partitionDir = this.fsUtils.joinPath(this.basePath, DIRECTORIES.data, partition);
      await this.fsUtils.ensureDir(partitionDir);
      const partitionManifestPath = this.fsUtils.joinPath(partitionDir, FILE_PATTERNS.manifest);

      // 读取或创建分区清单
      let pManifest: ManifestContent;
      try {
        const exists = await this.fsUtils.fileExists(partitionManifestPath);
        pManifest = exists ? await this.fsUtils.readJSON<ManifestContent>(partitionManifestPath) : this.createEmptyManifest();
      } catch (e) {
        pManifest = this.createEmptyManifest();
      }

      // 确保 filename 使用相对路径，包含 data/ 分区前缀
      if (!metadata.filename.startsWith(DIRECTORIES.data)) {
        metadata.filename = this.fsUtils.joinPath(DIRECTORIES.data, partition, metadata.filename);
      }

      // 更新序列号/时间戳并添加文件
      if (metadata.endSeq > pManifest.lastSequence) pManifest.lastSequence = metadata.endSeq;
      if (metadata.timestamp > pManifest.lastTimestamp) pManifest.lastTimestamp = metadata.timestamp;
      pManifest.files.push(metadata);
      pManifest.files.sort((a, b) => a.startSeq - b.startSeq);

      // 写入分区清单
      await this.fsUtils.atomicWrite(partitionManifestPath, pManifest);

      // 更新 manifest-index
      let index: any = { version: STORAGE_VERSION, partitions: {} };
      try {
        const idxExists = await this.fsUtils.fileExists(this.manifestIndexPath);
        if (idxExists) {
          index = await this.fsUtils.readJSON<any>(this.manifestIndexPath);
        }
      } catch (e) {
        index = { version: STORAGE_VERSION, partitions: {} };
      }

      index.partitions = index.partitions || {};
      index.partitions[partition] = {
        manifestPath: partitionManifestPath,
        lastSequence: pManifest.lastSequence,
        lastTimestamp: pManifest.lastTimestamp,
      };

      await this.fsUtils.atomicWrite(this.manifestIndexPath, index);
      return;
    }

    // 否则写入根清单（向后兼容）
    const manifest = await this.readManifest();
    if (metadata.endSeq > manifest.lastSequence) {
      manifest.lastSequence = metadata.endSeq;
    }
    if (metadata.timestamp > manifest.lastTimestamp) {
      manifest.lastTimestamp = metadata.timestamp;
    }
    manifest.files.push(metadata);
    manifest.files.sort((a, b) => a.startSeq - b.startSeq);
    await this.writeManifest(manifest);
  }

  /**
   * 更新文件元数据（用于合并后）
   */
  async updateFile(filename: string, metadata: Partial<DataFileMetadata>): Promise<void> {
    const manifest = await this.readManifest();
    const fileIndex = manifest.files.findIndex(f => f.filename === filename);
    if (fileIndex === -1) return;

    const target = manifest.files[fileIndex];
    const updated = { ...target, ...metadata };

    // 如果文件属于分区，更新分区清单
    if ((target as any).partition) {
      const partition = (target as any).partition as string;
      const partitionManifestPath = this.fsUtils.joinPath(this.basePath, DIRECTORIES.data, partition, FILE_PATTERNS.manifest);
      try {
        const pManifest = await this.fsUtils.readJSON<ManifestContent>(partitionManifestPath);
        const idx = pManifest.files.findIndex(f => f.filename === filename);
        if (idx !== -1) {
          pManifest.files[idx] = { ...pManifest.files[idx], ...metadata };
          await this.fsUtils.atomicWrite(partitionManifestPath, pManifest);
        }
      } catch (e) {
        // ignore
      }
      return;
    }

    // 否则更新根清单
    manifest.files[fileIndex] = updated;
    await this.writeManifest(manifest);
  }

  /**
   * 获取所有数据文件（按序列号排序）
   */
  async getFiles(): Promise<DataFileMetadata[]> {
    const manifest = await this.readManifest();
    if (manifest.files.length > 0) {
      return [...manifest.files];
    }

    return await this.recoverFilesFromStorage();
  }

  /**
   * 获取最新的序列号
   */
  async getLastSequence(): Promise<number> {
    const files = await this.getFiles();
    return files.reduce((max, file) => Math.max(max, file.endSeq), 0);
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

  /**
   * 当 manifest 缺失、损坏或为空时，从 data/ 与 merged/ 目录恢复数据文件列表。
   * 支持根目录文件和 YYYY/MM 分区目录。
   */
  private async recoverFilesFromStorage(): Promise<DataFileMetadata[]> {
    const recovered: DataFileMetadata[] = [];

    await this.scanDataLikeDirectory(
      this.fsUtils.joinPath(this.basePath, DIRECTORIES.data),
      DIRECTORIES.data,
      /^data-(\d+)-(\d+)-(\d+)\.json$/,
      false,
      recovered
    );

    await this.scanDataLikeDirectory(
      this.fsUtils.joinPath(this.basePath, DIRECTORIES.merged),
      DIRECTORIES.merged,
      /^merged-(\d+)-(\d+)-(\d+)\.json$/,
      true,
      recovered
    );

    const deduped = new Map<string, DataFileMetadata>();
    for (const file of recovered) {
      deduped.set(file.filename, file);
    }

    return Array.from(deduped.values()).sort((a, b) => a.startSeq - b.startSeq);
  }

  private async scanDataLikeDirectory(
    absoluteDir: string,
    logicalDir: string,
    filePattern: RegExp,
    isMerged: boolean,
    out: DataFileMetadata[],
    relativeParts: string[] = []
  ): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await this.fs.readdir(absoluteDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === FILE_PATTERNS.manifest || entry === FILE_PATTERNS.manifestIndex) {
        continue;
      }

      const entryPath = this.fsUtils.joinPath(absoluteDir, entry);
      let isDirectory = false;
      try {
        isDirectory = (await this.fs.stat(entryPath)).isDirectory();
      } catch {
        isDirectory = false;
      }

      if (isDirectory) {
        await this.scanDataLikeDirectory(
          entryPath,
          logicalDir,
          filePattern,
          isMerged,
          out,
          [...relativeParts, entry]
        );
        continue;
      }

      const match = filePattern.exec(entry);
      if (!match) continue;

      const startSeq = parseInt(match[1], 10);
      const endSeq = parseInt(match[2], 10);
      const timestamp = parseInt(match[3], 10);
      const filename = this.fsUtils.joinPath(logicalDir, ...relativeParts, entry);
      const partition = relativeParts.length > 0 ? relativeParts.join('/') : undefined;

      out.push({
        filename,
        startSeq,
        endSeq,
        timestamp,
        documentCount: 0,
        ...(partition ? { partition } : {}),
        ...(isMerged ? { mergedFrom: [] } : {}),
      });
    }
  }
}
