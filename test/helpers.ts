import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Backoff } from "@rc/core";
import { Daemon, normalizeConfig, type DaemonConfig, type Logger } from "@rc/daemon";
import { loadOrCreateIdentity, pair, RemoteClient } from "@rc/client";

export const quietLogger: Logger = { info: () => {}, warn: () => {} };

export interface Env {
  dir: string;
  cfg: DaemonConfig;
  daemon: Daemon;
  url: string;
  cleanup: () => Promise<void>;
}

let counter = 0;

export async function startEnv(overrides: Partial<DaemonConfig> = {}, port = 0): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "rc-test-"));
  const sock = `rctest-${process.pid}-${++counter}`;
  const cfg = {
    ...normalizeConfig({
      name: "test-daemon",
      listen: { host: "127.0.0.1", port },
      stateDir: join(dir, "state"),
      hookPort: 0,
      terminal: { tmuxSocket: sock, session: "claude", command: "bash --norc --noprofile", cwd: dir },
    }),
    ...overrides,
  };
  const daemon = new Daemon(cfg, quietLogger, 100, 400);
  await daemon.start();
  const url = `http://127.0.0.1:${daemon.port}`;
  return {
    dir,
    cfg,
    daemon,
    url,
    cleanup: async () => {
      await daemon.stop();
      try {
        execFileSync("tmux", ["-L", sock, "kill-server"], { stdio: "ignore" });
      } catch {
        /* 没有 tmux server */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 生成一个本地身份并完成配对，返回连接好的客户端（未 start） */
export async function pairedClient(env: Env, name = "laptop"): Promise<RemoteClient> {
  const id = loadOrCreateIdentity(join(env.dir, `client-${name}-${++counter}`));
  const code = env.daemon.devices.createPairingCode();
  const r = await pair(env.url, code, name, id.publicKey);
  return new RemoteClient({
    url: env.url,
    deviceId: r.deviceId,
    privateKey: id.privateKey,
    heartbeatMs: 100,
    heartbeatTimeoutMs: 1000,
    backoff: new Backoff(30, 200, 0),
  });
}

export function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000, label = "condition"): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let v: T | undefined | false;
      try {
        v = fn();
      } catch {
        v = undefined;
      }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

export function once<T extends unknown[]>(emitter: { once(ev: string, fn: (...a: T) => void): unknown }, ev: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), timeoutMs);
    emitter.once(ev, (...a: T) => {
      clearTimeout(timer);
      resolve(a);
    });
  });
}
