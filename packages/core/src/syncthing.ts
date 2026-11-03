import { EventEmitter } from "node:events";
import { Backoff, sleep } from "./backoff";
import type { EventBody } from "./protocol";

/**
 * 监听一个 Syncthing 实例的事件流，翻译成本项目的事件。
 *
 * 两端通用：远程 daemon 用它监听远程 Syncthing（本地 -> 远程 的接收进度、文件到达），
 * 本地客户端也可以用它监听本地 Syncthing（远程 -> 本地 的接收进度）。
 *
 * Syncthing 的 /rest/events 是长轮询：带上 since=上次看到的 id，
 * 没有新事件时服务端挂起最多 timeout 秒再返回空数组。
 * 用 events= 过滤类型时，事件的 id 是"这个订阅内"的编号，所以 since 必须用同一套过滤条件下的 id。
 */

const EVENT_TYPES = ["ItemStarted", "ItemFinished", "DownloadProgress", "StateChanged"] as const;

export interface SyncthingOptions {
  /** 例如 http://127.0.0.1:8384 */
  url: string;
  apiKey: string;
  /** 长轮询挂起秒数 */
  pollTimeoutSec?: number;
  /** 同一个文件的进度事件最小间隔 */
  progressIntervalMs?: number;
}

interface StEvent {
  id: number;
  type: string;
  time: string;
  data: any;
}

export interface SyncthingWatcherEvents {
  event: [EventBody];
}

export class SyncthingWatcher extends EventEmitter<SyncthingWatcherEvents> {
  private abort = new AbortController();
  private since = 0;
  private startTime: string | null = null;
  private up: boolean | null = null;
  private lastProgress = new Map<string, number>();
  private running: Promise<void> | null = null;

  constructor(private readonly opts: SyncthingOptions) {
    super();
  }

  start(): void {
    if (!this.running) this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.running?.catch(() => {});
  }

  private async get(path: string, timeoutMs: number): Promise<any> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    this.abort.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(new URL(path, this.opts.url), {
        headers: { "X-API-Key": this.opts.apiKey },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Syncthing ${path} -> HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener("abort", onAbort);
    }
  }

  private setUp(up: boolean, error?: string) {
    if (this.up === up) return;
    this.up = up;
    this.emit("event", { t: "sync.connection", status: up ? "up" : "down", ...(error ? { error } : {}) });
  }

  /** Syncthing 重启后事件 id 会从头编号；用 startTime 检测重启，避免一直等一个不会到来的 id。 */
  private async checkRestart(): Promise<void> {
    const status = await this.get("/rest/system/status", 10_000);
    const st = String(status.startTime ?? "");
    if (this.startTime !== null && st !== this.startTime) this.since = 0;
    this.startTime = st;
  }

  private async loop(): Promise<void> {
    const backoff = new Backoff();
    const timeoutSec = this.opts.pollTimeoutSec ?? 60;
    const types = EVENT_TYPES.join(",");
    let first = true;
    while (!this.abort.signal.aborted) {
      try {
        await this.checkRestart();
        if (first) {
          // 只关心启动之后的新事件：先取最新一条的 id 作为起点
          const latest: StEvent[] = await this.get(`/rest/events?events=${types}&limit=1&timeout=1`, 15_000);
          this.since = latest.length ? latest[latest.length - 1].id : 0;
          first = false;
        }
        this.setUp(true);
        backoff.reset();
        const events: StEvent[] = await this.get(
          `/rest/events?events=${types}&since=${this.since}&timeout=${timeoutSec}`,
          (timeoutSec + 15) * 1000,
        );
        for (const ev of events) {
          if (ev.id > this.since) this.since = ev.id;
          this.translate(ev);
        }
      } catch (err) {
        if (this.abort.signal.aborted) break;
        this.setUp(false, err instanceof Error ? err.message : String(err));
        await sleep(backoff.next(), this.abort.signal);
      }
    }
  }

  private translate(ev: StEvent): void {
    const d = ev.data ?? {};
    switch (ev.type) {
      case "ItemStarted":
        if (d.type !== "file") return;
        this.emit("event", { t: "sync.item", folder: d.folder, path: d.item, action: d.action, phase: "started" });
        return;
      case "ItemFinished": {
        if (d.type !== "file") return;
        const error = d.error ? String(d.error) : undefined;
        this.emit("event", {
          t: "sync.item",
          folder: d.folder,
          path: d.item,
          action: d.action,
          phase: "finished",
          ...(error ? { error } : {}),
        });
        this.lastProgress.delete(`${d.folder}\0${d.item}`);
        // 只有"更新且成功"才算文件就绪；删除、元数据变更不算
        if (!error && d.action === "update") {
          this.emit("event", { t: "file.ready", folder: d.folder, path: d.item });
        }
        return;
      }
      case "DownloadProgress": {
        // 结构：{ folderId: { fileName: { bytesDone, bytesTotal, ... } } }
        const now = Date.now();
        const interval = this.opts.progressIntervalMs ?? 1000;
        for (const [folder, files] of Object.entries<any>(d)) {
          for (const [path, p] of Object.entries<any>(files ?? {})) {
            const key = `${folder}\0${path}`;
            if (now - (this.lastProgress.get(key) ?? 0) < interval) continue;
            this.lastProgress.set(key, now);
            this.emit("event", {
              t: "sync.progress",
              folder,
              path,
              bytesDone: Number(p.bytesDone ?? 0),
              bytesTotal: Number(p.bytesTotal ?? 0),
            });
          }
        }
        return;
      }
      case "StateChanged":
        this.emit("event", { t: "sync.folder", folder: d.folder, state: d.to });
        return;
    }
  }
}
