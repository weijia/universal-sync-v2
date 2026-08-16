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
 * 检查是否为合并文件（merged-{timestamp}.json）
 * 排除 merged-up-to-* 标记文件（不以 .json 结尾）
 */
export function isMergedFile(filename: string): boolean {
  return filename.startsWith('merged-') && filename.endsWith('.json');
}

/**
 * 检查是否为数据文件（非合并）
 */
export function isDataFile(filename: string): boolean {
  return filename.startsWith('data-');
}

/**
 * 从 data/merged 文件名解析 timestamp（rev2 命名：data-{timestamp}.json）
 */
export function parseTimestampFromFilename(filename: string): number | null {
  const match = filename.match(/^(?:data|merged)-(.+)\.json$/);
  if (!match) return null;
  const iso = match[1].replace(/-/g, (ch, idx) => (idx === 13 ? ':' : idx === 15 ? '.' : ch));
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : ts;
}

/**
 * 计算字符串的 UTF-8 字节长度（跨平台，浏览器/Node 均可用 TextEncoder）
 */
export function byteLengthOf(str: string): number {
  return new TextEncoder().encode(str).length;
}

/**
 * 生成「UTC 月份」键，形如 2026-08。
 * 合并去重以 UTC 月为维度，确保不同时区/不同本地时钟的电脑看到同一份"月份"，
 * 避免东京已是 8 月、洛杉矶仍是 7 月导致同一个月被合并两次。
 */
export function utcMonthKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * 上一个 UTC 月份的键（用于「每月合并上个月」语义）。
 * 直接用 Date 回退一个月，规避各月天数不同的问题。
 */
export function previousMonthKey(date: Date = new Date()): string {
  const d = new Date(date);
  d.setUTCDate(1);            // 先锁定到当月 1 号，避免 31 号回退溢出
  d.setUTCMonth(d.getUTCMonth() - 1);
  return utcMonthKey(d);
}

/**
 * 从 data 文件名（data-YYYY-MM-DDTHH-MM-SS-mmmZ.json）解析其所属 UTC 月份键。
 * 用于判断文件是否属「本月」（本月文件不参与合并，留到下月）。
 */
export function monthKeyOfDataFile(filename: string): string | null {
  const m = filename.match(/^data-(\d{4})-(\d{2})-\d{2}T/);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}
