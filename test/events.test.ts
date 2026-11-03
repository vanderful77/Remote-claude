import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "@rc/core";
import { EventLog } from "@rc/daemon";
import { Daemon } from "@rc/daemon";
import { once, pairedClient, quietLogger, startEnv, waitFor, type Env } from "./helpers";

describe("EventLog", () => {
  it("同一次启动内按序号补发", () => {
    const log = new EventLog(10);
    for (let i = 0; i < 5; i++) log.append({ t: "file.ready", folder: "f", path: `${i}` });
    const r = log.replay(log.bootId, 3);
    expect(r.reset).toBe(false);
    expect(r.events.map((e) => e.seq)).toEqual([4, 5]);
  });

  it("bootId 不同（daemon 重启过）要求客户端从头开始", () => {
    const log = new EventLog(10);
    log.append({ t: "file.ready", folder: "f", path: "a" });
    expect(log.replay("old-boot", 1).reset).toBe(true);
    expect(log.replay(null, 0).reset).toBe(true);
  });

  it("缺口已被挤出缓冲时要求从头开始", () => {
    const log = new EventLog(3);
    for (let i = 0; i < 10; i++) log.append({ t: "file.ready", folder: "f", path: `${i}` });
    // 缓冲里只剩 8,9,10；客户端只收到 5 为止，6、7 已经丢了
    const r = log.replay(log.bootId, 5);
    expect(r.reset).toBe(true);
    expect(r.events.map((e) => e.seq)).toEqual([8, 9, 10]);
    // 收到 7 为止则可以无缝续上
    expect(log.replay(log.bootId, 7)).toMatchObject({ reset: false });
  });
});

let env: Env | null = null;
afterEach(async () => {
  await env?.cleanup();
  env = null;
});

describe("断线重连与补发", () => {
  it("断线期间产生的事件，重连后按序补齐、无重复", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    const got: EventEnvelope[] = [];
    c.on("event", (e) => got.push(e));
    c.start();
    await once(c, "connected");
    env.daemon.emitEvent({ t: "file.ready", folder: "inbox", path: "a.txt" });
    await waitFor(() => got.some((e) => e.body.t === "file.ready"));

    // 模拟网络中断：服务端粗暴断开所有连接（客户端看到 1006，不是正常关闭）
    for (const ws of (env.daemon as any).wss.clients) ws.terminate();
    await once(c, "disconnected");
    // 断线期间发生的事
    env.daemon.emitEvent({ t: "file.ready", folder: "inbox", path: "b.txt" });
    env.daemon.emitEvent({ t: "file.ready", folder: "inbox", path: "c.txt" });

    await once(c, "connected");
    await waitFor(() => got.filter((e) => e.body.t === "file.ready").length === 3, 5000, "replay");
    const seqs = got.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(got.filter((e) => e.body.t === "file.ready").map((e) => (e.body as any).path)).toEqual(["a.txt", "b.txt", "c.txt"]);
    c.stop();
  });

  it("daemon 重启后客户端自动重连，并收到 reset", async () => {
    env = await startEnv();
    const port = env.daemon.port;
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    const oldBoot = c.bootId;

    await env.daemon.stop();
    const reset = once(c, "reset", 8000);
    const d2 = new Daemon({ ...env.cfg, listen: { host: "127.0.0.1", port } }, quietLogger, { heartbeatMs: 100, heartbeatTimeoutMs: 400 });
    await d2.start();
    env.daemon = d2; // cleanup 时停掉新的
    await reset;
    expect(c.bootId).not.toBe(oldBoot);
    c.stop();
  });

  it("心跳：服务端没有任何回应时，客户端判定超时并重连", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    // 让服务端"假死"：暂停底层 socket 的读取，TCP 连接还在，但不再有任何回应
    for (const ws of (env.daemon as any).wss.clients) (ws as any)._socket.pause();
    const [d] = await once<[{ code: number }]>(c, "disconnected", 5000);
    expect(d.code).toBe(1006);
    await once(c, "connected", 5000);
    c.stop();
  });
});
