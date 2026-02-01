/**
 * Validates browser download success for task completion.
 * Uses Chrome downloads API to check completed downloads since task start.
 */

import { createLogger } from '../log';

const logger = createLogger('DownloadValidator');

/** Check if task or plan text implies a download goal (e.g. 下载). */
export function isDownloadTask(task: string, planNextSteps?: string): boolean {
  const text = [task, planNextSteps ?? ''].join(' ');
  return /下载|download/i.test(text);
}

/**
 * Parse expected number of files from task text.
 * Examples: "下载3个PPT" -> 3, "下载一篇" -> 1, "下载多个" -> null (unknown, use 1 as min).
 */
export function getExpectedDownloadCount(task: string): number | null {
  if (/一篇|一个|一份|下载1个|下载1份/i.test(task)) return 1;
  const m = task.match(/(\d+)\s*[个份篇张]|([一二三四五六七八九十百千]+)\s*[个份篇张]/);
  if (m) {
    if (m[1]) return Math.min(100, Math.max(1, parseInt(m[1], 10)));
    if (m[2]) {
      const map: Record<string, number> = {
        一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
      };
      let n = 0;
      for (const c of m[2]) n = (map[c] ?? 0) + n * 10;
      return n > 0 ? Math.min(100, n) : 1;
    }
  }
  if (/多个|若干|几个|多份/i.test(task)) return null;
  return null;
}

export interface CompletedDownloadsResult {
  count: number;
  items: chrome.downloads.DownloadItem[];
}

/**
 * Get completed downloads that started after the given timestamp (ms).
 * Requires "downloads" permission.
 */
export async function getCompletedDownloadsSince(sinceMs: number): Promise<CompletedDownloadsResult> {
  if (typeof chrome === 'undefined' || !chrome.downloads?.search) {
    logger.warning('chrome.downloads.search not available');
    return { count: 0, items: [] };
  }
  try {
    const startedAfter = new Date(sinceMs).toISOString();
    const items = await chrome.downloads.search({
      startedAfter,
      state: 'complete',
      limit: 100,
      orderBy: ['-startTime'],
    });
    return { count: items.length, items };
  } catch (e) {
    logger.error('getCompletedDownloadsSince failed', e);
    return { count: 0, items: [] };
  }
}

export interface DownloadValidationResult {
  /** True if completed download count meets or exceeds expected (or >= 1 when expected unknown). */
  success: boolean;
  completedCount: number;
  expectedCount: number;
  /** Human-readable summary for final_answer. */
  summary?: string;
}

/**
 * Validate that browser download(s) succeeded for a download task.
 * @param task - User task text
 * @param sinceMs - Task start time (ms) to count downloads from
 * @param planNextSteps - Optional planner next_steps for isDownloadTask heuristic
 */
export async function validateDownloadSuccess(
  task: string,
  sinceMs: number,
  planNextSteps?: string,
): Promise<DownloadValidationResult> {
  if (!isDownloadTask(task, planNextSteps)) {
    return { success: true, completedCount: 0, expectedCount: 0 };
  }
  const expected = getExpectedDownloadCount(task);
  const required = expected !== null ? expected : 1;
  const { count, items } = await getCompletedDownloadsSince(sinceMs);
  const success = count >= required;
  const summary =
    count > 0
      ? items
          .slice(0, 5)
          .map(i => i.filename?.split(/[/\\]/).pop() ?? i.url)
          .join('、')
      : undefined;
  logger.info(
    `validateDownloadSuccess: completed=${count}, required=${required}, success=${success}`,
    summary,
  );
  return {
    success,
    completedCount: count,
    expectedCount: required,
    summary: success && summary ? `已成功下载 ${count} 个文件（如：${summary}${count > 5 ? '...' : ''}）` : undefined,
  };
}
