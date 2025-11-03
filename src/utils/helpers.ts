/**
 * 生成唯一 ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 延迟执行
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 格式化时间戳为文件名友好的格式
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[:.]/g, '-');
}

/**
 * 解析版本号
 */
export function parseVersion(version: string): number[] {
  return version.split('.').map(Number);
}

/**
 * 比较版本号
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = parseVersion(v1);
  const parts2 = parseVersion(v2);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  
  return 0;
}

/**
 * 检查是否为合并文件
 */
export function isMergedFile(filename: string): boolean {
  return filename.startsWith('merged-');
}

/**
 * 从文件名解析序列号
 */
export function parseSequenceFromFilename(filename: string): number | null {
  const match = filename.match(/data-(\d+)-/);
  if (match) {
    return parseInt(match[1], 10);
  }
  
  const mergedMatch = filename.match(/merged-(\d+)-(\d+)-/);
  if (mergedMatch) {
    return parseInt(mergedMatch[1], 10);
  }
  
  return null;
}
