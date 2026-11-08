import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import WebSocket from "ws";
import { CloseCode } from "@rc/core";
import { pair, RemoteClient } from "@rc/client";
import { once, pairedClient, startEnv, waitFor, type Env } from "./helpers";

let env: Env | null = null;
afterEach(async () => {
  await env?.cleanup();
  env = null;
});

describe("配对", () => {
  it("正确的配对码只能用一次", async () => {
    env = await startEnv();
    const { publicKey } = generateKeyPairSync("ed25519");
    const x = publicKey.export({ format: "jwk" }).x!;
    const code = env.daemon.devices.createPairingCode();
    const r = await pair(env.url, code, "pc", x);
    expect(r.daemonName).toBe("test-daemon");
    expect(env.daemon.devices.list()).toHaveLength(1);
    await expect(pair(env.url, code, "pc2", x)).rejects.toThrow(/no active pairing code/);
  });

  it("配对码大小写和分隔符不敏感", async () => {
    env = await startEnv();
    const x = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
    const code = env.daemon.devices.createPairingCode();
    await pair(env.url, code.toLowerCase().replace("-", " "), "pc", x);
    expect(env.daemon.devices.list()).toHaveLength(1);
  });

  it("错 5 次后配对码作废", async () => {
    env = await startEnv();
    const x = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
    const code = env.daemon.devices.createPairingCode();
    for (let i = 0; i < 5; i++) await expect(pair(env.url, "WRONG-CODE", "pc", x)).rejects.toThrow();
    await expect(pair(env.url, code, "pc", x)).rejects.toThrow(/no active pairing code/);
  });

  it("过期的配对码不可用", async () => {
    env = await startEnv();
    const x = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
    const code = env.daemon.devices.createPairingCode(Date.now() - 11 * 60_000);
    await expect(pair(env.url, code, "pc", x)).rejects.toThrow(/expired/);
  });
});

describe("挑战应答鉴权", () => {
  it("已配对设备可以连接", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    c.start();
    const [info] = await once<[{ deviceName: string }]>(c, "connected");
    expect(info.deviceName).toBe("laptop");
    c.stop();
  });

  it("未配对的密钥被拒绝，且不再重连", async () => {
    env = await startEnv();
    const { privateKey } = generateKeyPairSync("ed25519");
    const c = new RemoteClient({ url: env.url, deviceId: "0000000000000000", privateKey });
    c.start();
    const [msg] = await once<[string]>(c, "fatal");
    expect(msg).toMatch(/鉴权失败/);
  });

  it("冒用别人的 deviceId（私钥不对）被拒绝", async () => {
    env = await startEnv();
    const real = await pairedClient(env);
    const { privateKey } = generateKeyPairSync("ed25519");
    const fake = new RemoteClient({ url: env.url, deviceId: env.daemon.devices.list()[0].id, privateKey });
    fake.start();
    await once(fake, "fatal");
    real.stop();
  });

  it("吊销后，运行中的连接被断开", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    const closed = new Promise<number>((resolve) => c.on("disconnected", (d) => resolve(d.code)));
    // 保证 mtime 变化可被察觉
    await new Promise((r) => setTimeout(r, 20));
    env.daemon.devices.revoke(env.daemon.devices.list()[0].id);
    expect(await closed).toBe(CloseCode.Revoked);
    await waitFor(() => !c.connected);
  });

  it("没有令牌或令牌无效时，终端和画面握手返回 401", async () => {
    env = await startEnv({ vnc: { host: "127.0.0.1", port: 1 } });
    for (const path of ["/term", "/vnc", "/term?token=abc", "/vnc?token=abc"]) {
      const ws = new WebSocket(env.url.replace("http", "ws") + path);
      const status = await new Promise<number>((resolve) => {
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => resolve(101));
        ws.on("error", () => {});
      });
      expect(status, path).toBe(401);
    }
  });
});
