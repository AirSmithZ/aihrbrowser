import { createLogger } from '@src/background/log';

const logger = createLogger('DownloadManager');

export interface DownloadProgressSnapshot {
  downloadId: number;
  filename?: string;
  url?: string;
  state?: string;
  bytesReceived?: number;
  totalBytes?: number;
  percent?: number | null;
}

export interface DetectDownloadOptions {
  /** Only consider downloads started after this timestamp (ms). */
  sinceMs: number;
  /** Prefer downloads triggered from this tab. */
  tabId?: number;
  /** How long to wait for a download to appear. */
  timeoutMs?: number;
  /** Polling interval for downloads.search. */
  pollIntervalMs?: number;
}

export interface WaitForCompletionOptions {
  /** Poll interval for progress updates. */
  pollIntervalMs?: number;
  /** Called when progress changes. */
  onProgress?: (snapshot: DownloadProgressSnapshot) => void | Promise<void>;
  /** Max time to wait for completion. */
  timeoutMs?: number;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface DownloadCompletionResult {
  downloadId: number;
  success: boolean;
  state: 'complete' | 'interrupted' | 'unknown';
  filename?: string;
  url?: string;
  error?: string;
}

function computePercent(bytesReceived?: number, totalBytes?: number): number | null {
  if (!bytesReceived || !totalBytes || totalBytes <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((bytesReceived / totalBytes) * 100)));
}

async function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('aborted');
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => resolve(), ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    }
  });
}

export class DownloadManager {
  /**
   * Wait for a new download to be created (event-driven, fast).
   * This is preferred over polling to avoid missing very fast downloads.
   *
   * 下载检测流程（事件驱动）：
   * 1. 在点击「下载」按钮前后调用本方法，传入 sinceMs、tabId。
   * 2. 监听 chrome.downloads.onCreated 事件，一旦有新下载且时间与 tab 匹配就立即返回 id。
   * 3. 如果在超时时间内没有事件，则在最后 fallback 一次到 detectDownloadStart 做一次轮询兜底。
   */
  async waitForNewDownload(options: DetectDownloadOptions): Promise<number | null> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;

    return await new Promise<number | null>(resolve => {
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        try {
          chrome.downloads.onCreated.removeListener(onCreated);
        } catch {
          // ignore
        }
        clearTimeout(timer);
      };

      const onCreated = (item: chrome.downloads.DownloadItem) => {
        try {
          const startTimeMs = item.startTime ? Date.parse(item.startTime) : Date.now();
          if (startTimeMs < options.sinceMs) return;
          const itemTabId = (item as chrome.downloads.DownloadItem & { tabId?: number }).tabId;
          // 如果下载条目携带了 tabId，则尽量按 tabId 过滤；
          // 但如果 Chrome 没有设置 tabId（undefined），则不要直接丢弃，避免漏检。
          if (options.tabId !== undefined && itemTabId !== undefined && itemTabId !== options.tabId) return;
          if (!item.id) return;

          logger.info('onCreated detected download', item.id, item.filename, item.url, itemTabId);
          cleanup();
          resolve(item.id);
        } catch (e) {
          // ignore and keep listening
        }
      };

      chrome.downloads.onCreated.addListener(onCreated);

      const timer = setTimeout(async () => {
        // Fallback to polling once near deadline to catch edge cases
        cleanup();
        const remainingMs = Math.max(0, deadline - Date.now());
        void remainingMs;
        // 给 fallback 一定时间窗口（最多 2s），真正轮询一次 downloads.search 兜底
        const fallbackTimeout = Math.min(2000, timeoutMs);
        const id = await this.detectDownloadStart({ ...options, timeoutMs: fallbackTimeout });
        resolve(id);
      }, timeoutMs);
    });
  }

  /**
   * Find the latest download that started after the given timestamp.
   * This is a lightweight, single-shot lookup based purely on the real
   * chrome.downloads list, without relying on onCreated events.
   */
  async findLatestDownloadSince(options: DetectDownloadOptions): Promise<DownloadProgressSnapshot | null> {
    const items = await chrome.downloads.search({
      startedAfter: new Date(options.sinceMs).toISOString(),
      orderBy: ['-startTime'],
      limit: 20,
    } as chrome.downloads.DownloadQuery);

    let candidate: chrome.downloads.DownloadItem | undefined;
    if (options.tabId !== undefined) {
      // 优先按 tabId 精确匹配；如果所有条目都没有匹配的 tabId，则退而求其次选择最新的一条
      candidate =
        items.find(it => {
          const itemTabId = (it as chrome.downloads.DownloadItem & { tabId?: number }).tabId;
          return itemTabId !== undefined && itemTabId === options.tabId;
        }) ?? items[0];
    } else {
      candidate = items[0];
    }

    if (!candidate || !candidate.id) {
      return null;
    }

    return {
      downloadId: candidate.id,
      filename: candidate.filename,
      url: candidate.url,
      state: candidate.state,
      bytesReceived: candidate.bytesReceived,
      totalBytes: candidate.totalBytes,
      percent: computePercent(candidate.bytesReceived, candidate.totalBytes),
    };
  }

  /**
   * Detect a newly started download (best-effort) by polling downloads.search.
   * Returns the downloadId if found within the timeout, otherwise null.
   */
  async detectDownloadStart(options: DetectDownloadOptions): Promise<number | null> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const pollIntervalMs = options.pollIntervalMs ?? 300;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const items = await chrome.downloads.search({
        startedAfter: new Date(options.sinceMs).toISOString(),
        // Try to get newest first (Chrome supports orderBy)
        orderBy: ['-startTime'],
        limit: 20,
      } as chrome.downloads.DownloadQuery);

      // Prefer matching tabId if available; otherwise use first candidate.
      const candidate =
        options.tabId !== undefined
          ? items.find(it => {
              const itemTabId = (it as chrome.downloads.DownloadItem & { tabId?: number }).tabId;
              // 只有当条目显式携带 tabId 且不相等时才排除；否则保留在候选集合中
              return itemTabId !== undefined && itemTabId === options.tabId;
            }) ?? items[0]
          : items[0];

      if (candidate?.id) {
        const itemTabId = (candidate as chrome.downloads.DownloadItem & { tabId?: number }).tabId;
        logger.info('Detected download start', candidate.id, candidate.filename, candidate.url, itemTabId);
        return candidate.id;
      }

      await sleep(pollIntervalMs);
    }

    return null;
  }

  async getSnapshot(downloadId: number): Promise<DownloadProgressSnapshot | null> {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) return null;

    return {
      downloadId,
      filename: item.filename,
      url: item.url,
      state: item.state,
      bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes,
      percent: computePercent(item.bytesReceived, item.totalBytes),
    };
  }

  /**
   * Wait until the download completes or is interrupted.
   * Emits progress snapshots via onProgress.
   */
  async waitForCompletion(downloadId: number, options: WaitForCompletionOptions = {}): Promise<DownloadCompletionResult> {
    const pollIntervalMs = options.pollIntervalMs ?? 800;
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000; // 5 minutes
    const deadline = Date.now() + timeoutMs;

    let lastPercent: number | null | undefined = undefined;
    let lastBytesReceived: number | undefined = undefined;
    let lastState: string | undefined = undefined;

    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        return { downloadId, success: false, state: 'unknown', error: 'aborted' };
      }

      const snapshot = await this.getSnapshot(downloadId);
      if (!snapshot) {
        // Could be removed or not visible yet
        await sleep(pollIntervalMs, options.signal);
        continue;
      }

      const changed =
        snapshot.percent !== lastPercent ||
        snapshot.bytesReceived !== lastBytesReceived ||
        snapshot.state !== lastState;

      if (changed && options.onProgress) {
        await options.onProgress(snapshot);
      }

      lastPercent = snapshot.percent;
      lastBytesReceived = snapshot.bytesReceived;
      lastState = snapshot.state;

      if (snapshot.state === 'complete') {
        return {
          downloadId,
          success: true,
          state: 'complete',
          filename: snapshot.filename,
          url: snapshot.url,
        };
      }

      if (snapshot.state === 'interrupted') {
        return {
          downloadId,
          success: false,
          state: 'interrupted',
          filename: snapshot.filename,
          url: snapshot.url,
          error: 'interrupted',
        };
      }

      await sleep(pollIntervalMs, options.signal);
    }

    return { downloadId, success: false, state: 'unknown', error: 'timeout' };
  }
}

