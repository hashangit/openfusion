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
