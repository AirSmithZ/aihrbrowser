/**
 * Store API response and console logs per request id in chrome.storage.local.
 * Key: aihr_request_logs. Value: Record<requestId, { response, consoleLogs, timestamp }>.
 * On task end (TASK_OK/FAIL/CANCEL/PAUSE), save to aihr_task_sessions so logs are visible.
 */

const STORAGE_KEY = 'aihr_request_logs';
const TASK_SESSIONS_KEY = 'aihr_task_sessions';
const CONSOLE_BUFFER_MAX = 200;
const LOGS_PER_REQUEST_MAX = 100;
const TASK_SESSION_LOGS_MAX = 300;

type RequestLogEntry = {
  response: unknown;
  consoleLogs: string[];
  timestamp: number;
};

export type TaskEndState = 'task.ok' | 'task.fail' | 'task.cancel' | 'task.pause';

type TaskSessionEntry = {
  taskId: string;
  state: TaskEndState;
  details?: string;
  timestamp: number;
  consoleLogs: string[];
};

const consoleBuffer: string[] = [];
let consolePatched = false;

function formatLog(level: string, args: unknown[]): string {
  const str = args
    .map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
    .join(' ');
  return `[${new Date().toISOString()}] [${level}] ${str}`;
}

function patchConsole(): void {
  if (consolePatched || typeof console === 'undefined') return;
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    consoleBuffer.push(formatLog('log', args));
    if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
    origLog.apply(console, args);
  };
  console.warn = (...args: unknown[]) => {
    consoleBuffer.push(formatLog('warn', args));
    if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
    origWarn.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    consoleBuffer.push(formatLog('error', args));
    if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
    origError.apply(console, args);
  };
  consolePatched = true;
}

/**
 * Store API response and recent console logs under request id.
 * Call this when a raw API response is received (e.g. in completionWithRetry).
 */
export function storeRequestLog(requestId: string, response: unknown): void {
  if (!requestId || typeof chrome?.storage?.local?.set !== 'function') return;
  patchConsole();
  const logs = consoleBuffer.slice(-LOGS_PER_REQUEST_MAX);
  const entry: RequestLogEntry = {
    response,
    consoleLogs: logs,
    timestamp: Date.now(),
  };
  chrome.storage.local.get(STORAGE_KEY, (prev: Record<string, unknown>) => {
    const all = (prev[STORAGE_KEY] as Record<string, RequestLogEntry>) || {};
    all[requestId] = entry;
    chrome.storage.local.set({ [STORAGE_KEY]: all });
  });
}

/**
 * Get stored logs for a request id.
 */
export function getRequestLog(requestId: string): Promise<RequestLogEntry | null> {
  return new Promise(resolve => {
    if (typeof chrome?.storage?.local?.get !== 'function') {
      resolve(null);
      return;
    }
    chrome.storage.local.get(STORAGE_KEY, (result: Record<string, unknown>) => {
      const all = (result[STORAGE_KEY] as Record<string, RequestLogEntry>) || {};
      resolve(all[requestId] ?? null);
    });
  });
}

/**
 * Get all stored request ids (e.g. for UI listing).
 */
export function getAllRequestIds(): Promise<string[]> {
  return new Promise(resolve => {
    if (typeof chrome?.storage?.local?.get !== 'function') {
      resolve([]);
      return;
    }
    chrome.storage.local.get(STORAGE_KEY, (result: Record<string, unknown>) => {
      const all = (result[STORAGE_KEY] as Record<string, RequestLogEntry>) || {};
      resolve(Object.keys(all));
    });
  });
}

/**
 * Persist task-end log to chrome.storage.local so logs are visible when a task terminates.
 * Call on TASK_OK, TASK_FAIL, TASK_CANCEL, TASK_PAUSE.
 * Stored under aihr_task_sessions: Record<taskId, TaskSessionEntry>.
 */
export function saveTaskEndLog(taskId: string, state: TaskEndState, details?: string): void {
  if (!taskId || typeof chrome?.storage?.local?.set !== 'function') return;
  patchConsole();
  const logs = consoleBuffer.slice(-TASK_SESSION_LOGS_MAX);
  const entry: TaskSessionEntry = {
    taskId,
    state,
    details,
    timestamp: Date.now(),
    consoleLogs: logs,
  };
  chrome.storage.local.get(TASK_SESSIONS_KEY, (prev: Record<string, unknown>) => {
    const all = (prev[TASK_SESSIONS_KEY] as Record<string, TaskSessionEntry>) || {};
    all[taskId] = entry;
    chrome.storage.local.set({ [TASK_SESSIONS_KEY]: all });
  });
}

/**
 * Get task session entry for a task id (e.g. last run result and logs).
 */
export function getTaskSessionLog(taskId: string): Promise<TaskSessionEntry | null> {
  return new Promise(resolve => {
    if (typeof chrome?.storage?.local?.get !== 'function') {
      resolve(null);
      return;
    }
    chrome.storage.local.get(TASK_SESSIONS_KEY, (result: Record<string, unknown>) => {
      const all = (result[TASK_SESSIONS_KEY] as Record<string, TaskSessionEntry>) || {};
      resolve(all[taskId] ?? null);
    });
  });
}
