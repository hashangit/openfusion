// Per-task timeout race for resilient fan-out (Constitution III).

export class TimeoutError extends Error {
  readonly code = "TIMEOUT";
  readonly retryable = true;
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`'${label}' exceeded ${timeoutMs}ms timeout`);
    this.name = "TimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race a promise against a timeout. On timeout, rejects with TimeoutError
 * (which carries code + retryable). The underlying promise is not cancelled —
 * callers should pass an AbortSignal-backed promise if true cancellation is needed.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface RetryOptions {
  /** Max attempts total (default 3 — i.e. 1 initial + 2 retries). */
  attempts?: number;
  /** Base delay between retries, in ms (default 500; uses exponential backoff). */
  baseDelayMs?: number;
}

export interface AttemptTimeoutOptions extends RetryOptions {
  /** Per-attempt timeout in ms (the clock resets on each retry). */
  timeoutMs: number;
  /** Label for timeout/error messages. */
  label: string;
}

/**
 * Run a factory that produces a promise, retrying on failure (thrown error OR
 * timeout). Each attempt gets a fresh timeout window. Backs off exponentially
 * between attempts. Resolves with the first success; rejects with the last
 * failure after all attempts are exhausted.
 */
export async function withRetryTimeout<T>(
  factory: () => Promise<T>,
  opts: AttemptTimeoutOptions,
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 500;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(factory(), opts.timeoutMs, opts.label);
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        const delay = baseDelay * 2 ** (attempt - 1); // 500ms, 1s, 2s, ...
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
