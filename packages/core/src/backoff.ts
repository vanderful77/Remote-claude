/**
 * 指数退避：1s, 2s, 4s ... 封顶 max，再乘一个随机抖动。
 * 抖动的作用：服务端重启时，所有客户端不会在同一毫秒一起重连。
 */
export class Backoff {
  private attempt = 0;

  constructor(
    private readonly baseMs = 1000,
    private readonly maxMs = 30_000,
    private readonly jitter = 0.2,
  ) {}

  next(): number {
    const raw = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt++;
    const delta = raw * this.jitter * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(raw + delta));
  }

  reset(): void {
    this.attempt = 0;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
