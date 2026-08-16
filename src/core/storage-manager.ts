import { IFileSystem, StoredDocument, DataFileContent, SyncOptions } from '../types.js';
import { FileSystemUtils } from '../utils/fs-utils.js';
import { formatTimestamp, isDataFile, isMergedFile, byteLengthOf } from '../utils/helpers.js';
import { STORAGE_VERSION, FILE_PATTERNS, DIRECTORIES, DEFAULT_CONFIG, MERGE_UP_TO_PREFIX, MERGE_MONTH_LOCK_PREFIX } from '../constants.js';
import { logStorageManager as log } from '../utils/logger.js';
import { utcMonthKey, previousMonthKey, monthKeyOfDataFile } from '../utils/helpers.js';

const debug = (...args: unknown[]): void => log.log('[StorageManager]', ...args);
const debugError = (...args: unknown[]): void => log.error('[StorageManager]', ...args);

/**
 * 存储管理器
 *
 * rev2 存储策略：
 * - 写入即分片：文件直接写入 data/YYYY/MM/DD/ 对应日期子目录（不再先写根目录再重排）
 * - 单文件体积上限 maxFileSize：一次写入差异集超过上限则拆成多个 data-{timestamp}.json
 * - 文件名不含 sequence，仅靠 timestamp 区分
 * - 文件发现靠递归列目录（data + merged），不依赖 manifest
 */
export class StorageManager {
  private fs: IFileSystem;
  private fsUtils: FileSystemUtils;
  private basePath: string;
  private maxFileSize: number;
  private mergeThreshold: number;
  private mergeCheckInterval: number;
  private autoMerge: boolean;

  constructor(fs: IFileSystem, options: SyncOptions) {
    this.fs = fs;
    this.fsUtils = new FileSystemUtils(fs);
    this.basePath = options.basePath;
    this.maxFileSize = options.maxFileSize ?? DEFAULT_CONFIG.maxFileSize;
    this.mergeThreshold = options.mergeThreshold ?? DEFAULT_CONFIG.mergeThreshold;
    this.mergeCheckInterval = options.mergeCheckInterval ?? DEFAULT_CONFIG.mergeCheckInterval;
    this.autoMerge = options.autoMerge ?? DEFAULT_CONFIG.autoMerge;
  }

  /**
   * 初始化存储目录
   */
  async initialize(): Promise<void> {
    await this.fsUtils.ensureDir(this.fsUtils.joinPath(this.basePath, DIRECTORIES.data));
    await this.fsUtils.ensureDir(this.fsUtils.joinPath(this.basePath, DIRECTORIES.merged));
  }

  get options(): Required<Pick<SyncOptions, 'maxFileSize' | 'mergeThreshold' | 'mergeCheckInterval' | 'autoMerge'>> {
    return {
      maxFileSize: this.maxFileSize,
      mergeThreshold: this.mergeThreshold,
      mergeCheckInterval: this.mergeCheckInterval,
      autoMerge: this.autoMerge,
    };
  }

  // ============ 写入 ============

  /**
   * 将差异文档集写入目标文件系统（写入即分片）
   */
  async writeDocuments(documents: StoredDocument[]): Promise<void> {
    const chunks = this.chunkBySize(documents, this.maxFileSize);
    // 每个 chunk 使用不同的 timestamp，避免同一次写入产生同名文件相互覆盖
    let timestamp = Date.now();
    for (const chunk of chunks) {
      await this.writeChunk(chunk, timestamp);
      timestamp += 1;
    }
  }

  /**
   * 按单文件体积上限把文档集切成若干 chunk
   */
  private chunkBySize(documents: StoredDocument[], maxFileSize: number): StoredDocument[][] {
    const chunks: StoredDocument[][] = [];
    let current: StoredDocument[] = [];
    let currentSize = 0;

    for (const doc of documents) {
      const docSize = byteLengthOf(JSON.stringify(doc));

      if (currentSize + docSize > maxFileSize && current.length > 0) {
        chunks.push(current);
        current = [];
        currentSize = 0;
      }

      current.push(doc);
      currentSize += docSize;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }

  /**
   * 把一个 chunk 写入 data/YYYY/MM/DD/data-{timestamp}.json（原子写入）
   */
  private async writeChunk(chunk: StoredDocument[], timestamp: number): Promise<void> {
    const content: DataFileContent = {
      version: STORAGE_VERSION,
      timestamp,
      documents: chunk,
    };

    const shardDir = this.shardDirForTimestamp(timestamp);
    const dirPath = this.fsUtils.joinPath(this.basePath, DIRECTORIES.data, shardDir);
    await this.fsUtils.ensureDir(dirPath);

    const filename = FILE_PATTERNS.data.replace('{timestamp}', formatTimestamp(timestamp));
    const filePath = this.fsUtils.joinPath(dirPath, filename);
    await this.fsUtils.atomicWrite(filePath, content);
  }

  /**
   * 由 timestamp 计算 data/YYYY/MM/DD 分片相对路径
   */
  private shardDirForTimestamp(timestamp: number): string {
    const d = new Date(timestamp);
    const y = String(d.getUTCFullYear());
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  }

  // ============ 文件发现 ============

  /**
   * 递归列出 data + merged 目录下所有数据文件路径（含日期分片子目录）
   */
  async listAllDataFiles(): Promise<string[]> {
    const dataFiles = await this.collectShardFiles(
      this.fsUtils.joinPath(this.basePath, DIRECTORIES.data)
    );
    const mergedFiles = await this.collectShardFiles(
      this.fsUtils.joinPath(this.basePath, DIRECTORIES.merged)
    );
    let result = [...dataFiles, ...mergedFiles];
    debug(`listAllDataFiles: 层级下钻找到 ${dataFiles.length} 个 data 文件, ${mergedFiles.length} 个 merged 文件`);

    // 兜底：若层级下钻未找到任何文件（某些 WebDAV 对层级/stat 行为异常），
    // 从 basePath 做全树枚举（带防环 + 自引用防御），直接按文件名匹配收集。
    if (result.length === 0) {
      debug('listAllDataFiles: 层级下钻结果为空，启用全树枚举兜底');
      result = await this.fallbackListAll();
      debug(`listAllDataFiles: 兜底枚举找到 ${result.length} 个文件`);
    }
    return result;
  }

  /**
   * 全树枚举兜底：从 basePath 递归 readdir，不依赖层级格式与 isDirectory，
   * 遇到「集合自身当子条目返回」或重复路径则跳过，按文件名匹配 data-/merged- 文件。
   */
  private async fallbackListAll(): Promise<string[]> {
    const found: string[] = [];
    const visited = new Set<string>();

    const walk = async (dir: string): Promise<void> => {
      if (visited.has(dir)) return;
      visited.add(dir);
      const entries = await this.readDirSafe(dir);
      const dirBase = this.baseName(dir);
      for (const entry of entries) {
        if (entry === dirBase) continue; // 跳过 WebDAV 自引用条目
        const entryPath = this.fsUtils.joinPath(dir, entry);
        if (isDataFile(entry) || isMergedFile(entry)) {
          found.push(entryPath);
          continue;
        }
        // 无法可靠判断是否为目录时，统一尝试下钻（已访问集合防环）
        await walk(entryPath);
      }
    };

    await walk(this.basePath);
    return found;
  }

  /**
   * 按 data/merged 的固定层级 YYYY/MM/DD 收集数据文件。
   * 不依赖 WebDAV 的 isDirectory 判定（teracloud 等会把集合自身当子条目返回，
   * 且 stat 对 404 行为不稳定），改为按层级格式直接下钻，天然过滤自引用/噪声条目。
   */
  private async collectShardFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    debug(`collectShardFiles: 起始目录=${root}`);
    const rootBase = this.baseName(root);
    // 兼容旧版：merged 文件可能直接写在 root 根目录（未按 YYYY/MM/DD 分片），这里补扫一层
    try {
      const rootEntries = await this.readDirSafe(root);
      for (const entry of rootEntries) {
        if (isMergedFile(entry)) files.push(this.fsUtils.joinPath(root, entry));
      }
    } catch {
      /* root 不存在时忽略 */
    }
    const years = await this.readFiltered(root, /^\d{4}$/, rootBase);
    debug(`collectShardFiles: ${root} 下年份=[${years.join(', ')}]`);
    for (const y of years) {
      const yearPath = this.fsUtils.joinPath(root, y);
      const months = await this.readFiltered(yearPath, /^\d{2}$/, y);
      debug(`collectShardFiles: ${yearPath} 下月份=[${months.join(', ')}]`);
      for (const m of months) {
        const monthPath = this.fsUtils.joinPath(yearPath, m);
        const days = await this.readFiltered(monthPath, /^\d{2}$/, m);
        debug(`collectShardFiles: ${monthPath} 下日期=[${days.join(', ')}]`);
        for (const d of days) {
          const dayPath = this.fsUtils.joinPath(monthPath, d);
          const entries = await this.readDirSafe(dayPath);
          debug(`collectShardFiles: ${dayPath} 下条目=[${entries.join(', ')}]`);
          for (const entry of entries) {
            if (isDataFile(entry) || isMergedFile(entry)) {
              files.push(this.fsUtils.joinPath(dayPath, entry));
            }
          }
        }
      }
    }
    debug(`collectShardFiles: 共找到 ${files.length} 个文件`);
    return files;
  }

  private async readFiltered(dir: string, pattern: RegExp, exclude?: string): Promise<string[]> {
    const entries = await this.readDirSafe(dir);
    // 记录未匹配格式的原始条目，便于发现 WebDAV 自引用/异常命名
    const unmatched = entries.filter(e => !pattern.test(e));
    if (unmatched.length > 0) {
      debug(`readFiltered: ${dir} 下未匹配 ${pattern} 的条目=[${unmatched.join(', ')}]`);
    }
    // 跳过 WebDAV 把集合自身当子条目返回的情况（如 /data/2026/08 下出现 "08"）
    return entries.filter(e => pattern.test(e) && e !== exclude);
  }

  private async readDirSafe(dir: string): Promise<string[]> {
    try {
      const entries = await this.fs.readdir(dir);
      return entries;
    } catch (e) {
      debugError(`readDirSafe: 读取 ${dir} 失败:`, (e as Error)?.message ?? e);
      return [];
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await this.fs.stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  // ============ 读取 ============

  /**
   * 读取所有文件并合并去重，返回每个文档的最新版本（按 _rev generation 取大）
   */
  async readAllDocuments(): Promise<StoredDocument[]> {
    const files = await this.listAllDataFiles();
    const allDocs = await this.readDocumentsFromFiles(files);
    return this.latestByRev(allDocs);
  }

  private async readDocumentsFromFiles(files: string[]): Promise<StoredDocument[]> {
    const docs: StoredDocument[] = [];
    for (const file of files) {
      try {
        const content = await this.fsUtils.readJSON<DataFileContent>(file);
        if (Array.isArray(content.documents)) {
          docs.push(...content.documents);
        }
      } catch {
        // 跳过损坏文件
      }
    }
    return docs;
  }

  /**
   * 读取单个文件的完整内容（含 documents）
   */
  async readFileContent(file: string): Promise<DataFileContent> {
    return this.fsUtils.readJSON<DataFileContent>(file);
  }

  /**
   * 按 docId 取 _rev generation 最大者
   */
  private latestByRev(docs: StoredDocument[]): StoredDocument[] {
    const latest = new Map<string, StoredDocument>();
    for (const doc of docs) {
      const existing = latest.get(doc._id);
      if (!existing || this.revGeneration(doc._rev) > this.revGeneration(existing._rev)) {
        latest.set(doc._id, doc);
      }
    }
    return Array.from(latest.values());
  }

  private revGeneration(rev: string): number {
    const n = parseInt(rev.split('-')[0], 10);
    return Number.isNaN(n) ? 0 : n;
  }

  // ============ 合并 ============

  /**
   * 找到可合并的候选组（「每月合并上个月」语义）。
   * 只聚合「当前月之前（上月及更早）」的 data 文件；本月新写入的 data 不参与，留到下月。
   * 因此即便只有 1 个历史 data 文件也会返回候选（合并后该文件从 data 移走、空目录被清理），
   * 从而持续压低 data 目录的文件数与层级。
   * 按累计体积（不超过 maxFileSize）分批；不依赖 mergeThreshold 硬门槛——WebDAV 的 size() 常不可靠。
   * @param force 跳过「排除本月文件」过滤（手动/测试用），连同本月的 data 一起合并。
   */
  async findMergeCandidates(force = false): Promise<string[][]> {
    const allFiles = await this.listAllDataFiles();
    debug(`findMergeCandidates: listAllDataFiles 返回 ${allFiles.length} 个文件 -> [${allFiles.join(', ')}]`);
    // 仅合并 data 下的源文件（不含 merged 下已合并的文件，避免重复合并）
    const dataFiles = allFiles.filter(f => `/${f}/`.includes(`/${DIRECTORIES.data}/`));
    debug(`findMergeCandidates: 其中 data 源文件 ${dataFiles.length} 个 -> [${dataFiles.join(', ')}]`);

    const currentMonth = utcMonthKey();
    const mergeable = dataFiles.filter(f => {
      const key = monthKeyOfDataFile(this.baseName(f));
      if (key === null) return false;
      if (force) return true; // 手动/测试：连同本月 data 一起合并
      return key < currentMonth; // 文件名月份早于本月（字符串 YYYY-MM 比较即时间序）
    });
    debug(`findMergeCandidates: ${force ? 'force=true 不排除本月，' : '排除本月文件后，'}可合并的 data 源文件 ${mergeable.length} 个 -> [${mergeable.join(', ')}]`);
    if (mergeable.length === 0) {
      debug(`findMergeCandidates: ${force ? '无任何 data 文件' : '无上月及更早的 data 文件，本月数据留待下月合并'}，无候选返回`);
      return [];
    }

    // 按累计体积分批：每批不超过 maxFileSize（下限放宽到 1 个文件即可成批）
    const batches: string[][] = [];
    let current: string[] = [];
    let currentSize = 0;
    for (const file of mergeable) {
      const size = await this.fileSizeOf(file);
      if (currentSize + size > this.maxFileSize && current.length >= 1) {
        batches.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(file);
      currentSize += size;
    }
    if (current.length >= 1) batches.push(current);

    return batches;
  }

  private async fileSizeOf(filePath: string): Promise<number> {
    try {
      return await this.fs.size(filePath);
    } catch {
      // WebDAV size() 不可靠时默认按"小"处理，确保文件能纳入合并
      return 0;
    }
  }

  /**
   * 执行一组文件的合并：读取全部文档 -> 去重取最新 ->
   * 写入 merged/merged-{timestamp}.json -> 把源文件移至 archive/<原相对路径>（可回溯）
   */
  async mergeFiles(fileGroup: string[]): Promise<void> {
    debug(`mergeFiles: 开始合并 ${fileGroup.length} 个文件 -> [${fileGroup.join(', ')}]`);
    const docs = await this.readDocumentsFromFiles(fileGroup);
    const merged = this.latestByRev(docs);
    debug(`mergeFiles: 读取到 ${docs.length} 个原始文档, 去重后 ${merged.length} 个`);

    const timestamp = Date.now();
    const filename = FILE_PATTERNS.merged.replace('{timestamp}', formatTimestamp(timestamp));
    // merged 每月只产出 1 个文件、一年至多 12 个，按年份目录归类：merged/YYYY/。
    // 合并标记文件 (merged-up-to-*.json) 仍放在 merged/ 根目录（固定名、体积小、便于直接 stat）。
    const yearDir = String(new Date(timestamp).getUTCFullYear());
    const mergedDir = this.fsUtils.joinPath(this.basePath, DIRECTORIES.merged, yearDir);
    await this.fsUtils.ensureDir(mergedDir);
    const mergedPath = this.fsUtils.joinPath(mergedDir, filename);
    debug(`mergeFiles: 写入合并文件 ${mergedPath} (${merged.length} 个文档)`);

    const content: DataFileContent = { version: STORAGE_VERSION, timestamp, documents: merged };
    await this.fsUtils.atomicWrite(mergedPath, content);
    debug(`mergeFiles: 合并文件写入完成`);

    // 合并成功后，将源文件移入 archive（保留原 data/YYYY/MM/DD 相对结构）
    const archiveRoot = this.fsUtils.joinPath(this.basePath, DIRECTORIES.archive);
    await this.fsUtils.ensureDir(archiveRoot);
    debug(`mergeFiles: 将源文件移至 archive (根=${archiveRoot})`);
    for (const file of fileGroup) {
      const rel = this.relativeToBase(file);
      const dest = this.fsUtils.joinPath(archiveRoot, rel);
      await this.moveToArchive(file, dest);
    }
    // 源文件移走后，自底向上清理 data 下的空目录（YYYY/MM/DD 直到 data 根），
    // 避免残留空目录累积层级。只删空目录，绝不动文件。
    for (const file of fileGroup) {
      const dataDir = this.fsUtils.joinPath(this.basePath, DIRECTORIES.data);
      if (file.startsWith(dataDir)) {
        await this.removeEmptyDirsUpward(this.parentDir(file), dataDir);
      }
    }
    debug(`mergeFiles: 合并流程结束`);
    // 合并成功后，在 WebDAV 上写「已合并到哪个月」标记（基于上月 UTC 月，跨时区/多设备共享）。
    // 标记文件放在 merged/ 根目录（固定名、体积小、便于直接 stat），不要按日期分片。
    await this.markMergedThisMonth(timestamp);
  }

  /**
   * 上个月的 data 是否已在共享存储上合并过（「每月合并上个月」语义）。
   * 标记键 = 上个月的 UTC 月（如 2026-08 运行时，标记 merged-up-to-2026-07 表示"7 月及更早已汇总"）。
   * 所有设备统一看 UTC 月，避免不同时区/本地时钟导致同一个月被重复合并。
   * 同时兼容旧版 `.last-merge-YYYY-MM` 标记（视为已合并）。
   */
  async hasMergedThisMonth(): Promise<boolean> {
    const prevKey = previousMonthKey();
    const newPath = this.fsUtils.joinPath(this.basePath, DIRECTORIES.merged, `${MERGE_UP_TO_PREFIX}${prevKey}`);
    try {
      await this.fs.stat(newPath);
      return true;
    } catch {
      /* 新标记不存在，继续看旧标记 */
    }
    const oldPath = this.fsUtils.joinPath(this.basePath, DIRECTORIES.merged, `${MERGE_MONTH_LOCK_PREFIX}${prevKey}`);
    try {
      await this.fs.stat(oldPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 写入「已合并到哪个月」标记（基于上个月 UTC 月）。内容为 UTC 写入时间戳（ISO 字符串），便于审计。
   * 若标记已存在（极小概率并发），覆盖即可——不影响去重语义。
   */
  private async markMergedThisMonth(timestamp: number): Promise<void> {
    const prevKey = previousMonthKey();
    const lockPath = this.fsUtils.joinPath(this.basePath, DIRECTORIES.merged, `${MERGE_UP_TO_PREFIX}${prevKey}`);
    try {
      await this.fs.writeFile(lockPath, JSON.stringify({ mergedUpTo: prevKey, at: new Date(timestamp).toISOString() }));
      debug(`已写入合并标记 ${lockPath}`);
    } catch (error) {
      debugError('写入合并标记失败（不影响本次合并结果）:', error);
    }
  }

  /**
   * 把 basePath 下的绝对路径转为相对 basePath 的路径（用于 archive 内保留原结构）
   */
  private relativeToBase(path: string): string {
    const prefix = this.basePath.endsWith('/') ? this.basePath : `${this.basePath}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  private parentDir(file: string): string {
    const idx = file.lastIndexOf('/');
    return idx === -1 ? file : file.slice(0, idx);
  }

  private baseName(file: string): string {
    const idx = file.lastIndexOf('/');
    return idx === -1 ? file : file.slice(idx + 1);
  }

  private async moveToArchive(src: string, dest: string): Promise<void> {
    try {
      await this.fsUtils.ensureDir(this.parentDir(dest));
      await this.fs.rename(src, dest);
      debug(`moveToArchive: rename 成功 ${src} -> ${dest}`);
    } catch (e) {
      debugError(`moveToArchive: rename 失败 ${src} -> ${dest}:`, (e as Error)?.message ?? e);
      // WebDAV rename 跨集合可能不支持，降级为复制+删除
      try {
        const content = await this.fs.readFile(src, 'utf8');
        await this.fsUtils.ensureDir(this.parentDir(dest));
        await this.fs.writeFile(dest, content);
        await this.safeUnlink(src);
        debug(`moveToArchive: 降级（复制+删源）成功 ${src} -> ${dest}`);
      } catch (e2) {
        debugError(`moveToArchive: 降级也失败，保留源文件 ${src}:`, (e2 as Error)?.message ?? e2);
        // 两者都失败则放弃移动（保留源文件，避免数据丢失）
      }
    }
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await this.fs.unlink(path);
    } catch {
      // 忽略删除失败
    }
  }

  /**
   * 清理空的日期分片子目录（data/YYYY/MM/DD 与 merged/YYYY/MM/DD），
   * 避免合并删除源文件后残留空目录。只删除空目录，不触碰任何文件。
   */
  async cleanupArchivedFiles(): Promise<void> {
    for (const root of [DIRECTORIES.data, DIRECTORIES.merged, DIRECTORIES.archive]) {
      const rootPath = this.fsUtils.joinPath(this.basePath, root);
      await this.removeEmptyDirs(rootPath);
    }
  }

  private async removeEmptyDirs(root: string): Promise<void> {
    let entries: string[];
    try {
      entries = await this.fs.readdir(root);
    } catch {
      return;
    }

    const rootBase = this.baseName(root);
    for (const entry of entries) {
      // 跳过 WebDAV 把集合自身当子条目返回的情况
      if (entry === rootBase) continue;

      const entryPath = this.fsUtils.joinPath(root, entry);
      const isDir = await this.isDirectory(entryPath);
      if (isDir) {
        await this.removeEmptyDirs(entryPath);
        if ((await this.fs.readdir(entryPath)).length === 0) {
          await this.safeRmdir(entryPath);
        }
      }
    }
  }

  private async safeRmdir(path: string): Promise<void> {
    try {
      await this.fs.rmdir(path);
    } catch {
      // 忽略删除失败（非空目录等）
    }
  }

  /**
   * 自底向上删除空目录：从 startDir 起逐层向上，遇到空目录就删，
   * 直到碰到 stopDir（含，不删）或目录非空/删除失败为止。
   * 用于合并后清理 data 下被移空的日期分片子目录，避免空目录累积。
   */
  private async removeEmptyDirsUpward(startDir: string, stopDir: string): Promise<void> {
    let dir = startDir;
    const stop = stopDir.endsWith('/') ? stopDir : `${stopDir}/`;
    while (dir.length > stop.length && dir.startsWith(stop)) {
      let entries: string[];
      try {
        entries = await this.fs.readdir(dir);
      } catch {
        return; // 读不到就停
      }
      if (entries.length > 0) return; // 非空：停止向上
      await this.safeRmdir(dir);
      // 上移到父目录
      const parent = this.parentDir(dir);
      if (parent === dir) return;
      dir = parent;
    }
  }
}
