import { sleep } from "./util";

export interface RetryOptions {
  max: number;
  baseMs: number;
  capMs?: number;
  timeoutMs?: number;
}

// Transient HTTP statuses worth retrying. Other 4xx are treated as permanent.
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
const isTransientStatus = (s: number): boolean => TRANSIENT.has(s);

const jitter = (ms: number): number =>
  ms + Math.floor(Math.random() * (ms / 2 + 1));

function parseRetryAfter(headers: Headers): number | null {
  const v = headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = Date.parse(v);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function delayMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  retryAfterMs: number | null,
): number {
  if (retryAfterMs != null) return Math.min(retryAfterMs, 30_000);
  return jitter(Math.min(baseMs * 2 ** attempt, capMs));
}

/**
 * fetch() with bounded retry on transient status / network errors.
 * Returns the final Response (which may be !ok for a permanent error — the
 * caller inspects status). Throws only on network error after exhausting retries.
 */
export async function fetchRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  const { max, baseMs, capMs = 8000, timeoutMs = 30_000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      if (isTransientStatus(res.status) && attempt < max - 1) {
        await sleep(delayMs(attempt, baseMs, capMs, parseRetryAfter(res.headers)));
        continue;
      }
      return res; // permanent, or transient exhausted — let caller decide
    } catch (err) {
      lastErr = err;
      if (attempt < max - 1) {
        await sleep(delayMs(attempt, baseMs, capMs, null));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("fetchRetry exhausted");
}

/**
 * Retry an arbitrary async op that resolves true on success / false to retry.
 * Returns true if it ever succeeded, else false (errors are swallowed).
 */
export async function retryAsync(
  fn: () => Promise<boolean>,
  opts: RetryOptions,
): Promise<boolean> {
  const { max, baseMs, capMs = 8000 } = opts;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      if (await fn()) return true;
    } catch {
      /* transient — retry */
    }
    if (attempt < max - 1) await sleep(delayMs(attempt, baseMs, capMs, null));
  }
  return false;
}
