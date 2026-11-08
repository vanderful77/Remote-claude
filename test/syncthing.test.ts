import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { SyncthingWatcher, type EventBody } from "@rc/core";
import { waitFor } from "./helpers";

/**
 * 假 Syncthing：实现 /rest/system/status 和长轮询 /rest/events 的最小子集。
 */
class FakeSyncthing {
  server!: Server;
  events: { id: number; type: string; time: string; data: unknown }[] = [];
  startTime = "2026-11-03T00:00:00Z";
  waiters: (() => void)[] = [];
  apiKeyOk = 0;

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      if (req.headers["x-api-key"] !== "k") return res.writeHead(403).end();
      this.apiKeyOk++;
      const u = new URL(req.url!, "http://x");
      if (u.pathname === "/rest/system/status") return res.end(JSON.stringify({ startTime: this.startTime }));
      if (u.pathname === "/rest/config/folders") return res.end(JSON.stringify([{ id: "inbox", path: "/home/claude/workspace/inbox" }]));
      if (u.pathname === "/rest/events") {
        const since = Number(u.searchParams.get("since") ?? 0);
        const limit = u.searchParams.get("limit");
        if (limit) return res.end(JSON.stringify(this.events.slice(-Number(limit))));
        const reply = () => res.end(JSON.stringify(this.events.filter((e) => e.id > since)));
        if (this.events.some((e) => e.id > since)) return reply();
        const t = setTimeout(reply, 300);
        this.waiters.push(() => {
          clearTimeout(t);
          reply();
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    return (this.server.address() as any).port;
  }

  push(type: string, data: unknown) {
    const id = (this.events.at(-1)?.id ?? 0) + 1;
    this.events.push({ id, type, time: new Date().toISOString(), data });
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** 模拟 Syncthing 重启：事件 id 从 1 重新开始 */
  restart() {
    this.events = [];
    this.startTime = "2026-11-03T01:00:00Z";
  }

  close() {
    this.waiters.forEach((f) => f());
    this.server.closeAllConnections();
    this.server.close();
  }
}

let fake: FakeSyncthing | null = null;
let watcher: SyncthingWatcher | null = null;
afterEach(async () => {
  await watcher?.stop();
  fake?.close();
  fake = null;
  watcher = null;
});

describe("SyncthingWatcher", () => {
  it("只关心启动后的事件，翻译成 sync.* 和 file.ready", async () => {
    fake = new FakeSyncthing();
    const port = await fake.start();
    fake.push("ItemFinished", { folder: "inbox", item: "old.txt", type: "file", action: "update", error: null });

    const got: EventBody[] = [];
    watcher = new SyncthingWatcher({ url: `http://127.0.0.1:${port}`, apiKey: "k", pollTimeoutSec: 1, progressIntervalMs: 0 });
    watcher.on("event", (e) => got.push(e));
    watcher.start();
    await waitFor(() => got.find((e) => e.t === "sync.connection"));

    fake.push("ItemStarted", { folder: "inbox", item: "data.zip", type: "file", action: "update" });
    fake.push("DownloadProgress", { inbox: { "data.zip": { bytesDone: 500, bytesTotal: 1000 } } });
    fake.push("ItemFinished", { folder: "inbox", item: "data.zip", type: "file", action: "update", error: null });
    fake.push("ItemFinished", { folder: "inbox", item: "gone.txt", type: "file", action: "delete", error: null });
    fake.push("ItemFinished", { folder: "inbox", item: "bad.bin", type: "file", action: "update", error: "disk full" });
    fake.push("StateChanged", { folder: "inbox", from: "syncing", to: "idle" });

    await waitFor(() => got.find((e) => e.t === "sync.folder"), 5000, "folder state");
    expect(got.filter((e) => e.t === "file.ready")).toEqual([
      { t: "file.ready", folder: "inbox", path: "data.zip", absPath: "/home/claude/workspace/inbox/data.zip" },
    ]);
    expect(got).toContainEqual({ t: "sync.progress", folder: "inbox", path: "data.zip", bytesDone: 500, bytesTotal: 1000 });
    expect(got).toContainEqual(expect.objectContaining({ t: "sync.item", path: "bad.bin", error: "disk full" }));
    // 启动前的旧事件不算
    expect(got.some((e) => "path" in e && e.path === "old.txt")).toBe(false);
  });

  it("Syncthing 重启（事件 id 归零）后仍能收到新事件", async () => {
    fake = new FakeSyncthing();
    const port = await fake.start();
    for (let i = 0; i < 5; i++) fake.push("StateChanged", { folder: "f", from: "a", to: `s${i}` });

    const got: EventBody[] = [];
    watcher = new SyncthingWatcher({ url: `http://127.0.0.1:${port}`, apiKey: "k", pollTimeoutSec: 1 });
    watcher.on("event", (e) => got.push(e));
    watcher.start();
    await waitFor(() => got.find((e) => e.t === "sync.connection"));

    fake.restart();
    fake.push("ItemFinished", { folder: "inbox", item: "after-restart.txt", type: "file", action: "update", error: null });
    await waitFor(() => got.find((e) => e.t === "file.ready"), 5000, "event after restart");
  });

  it("API Key 错误时报告断开，不会崩溃", async () => {
    fake = new FakeSyncthing();
    const port = await fake.start();
    const got: EventBody[] = [];
    watcher = new SyncthingWatcher({ url: `http://127.0.0.1:${port}`, apiKey: "wrong" });
    watcher.on("event", (e) => got.push(e));
    watcher.start();
    const ev = await waitFor(() => got.find((e) => e.t === "sync.connection"));
    expect(ev).toMatchObject({ status: "down" });
  });
});
