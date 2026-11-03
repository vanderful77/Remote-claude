import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DaemonConfig {
  /** 显示给客户端的名字 */
  name: string;
  listen: {
    /** 只应是 Tailscale IP（100.x.y.z）或 127.0.0.1 */
    host: string;
    port: number;
    /** 明确同意监听 0.0.0.0 / :: 才允许，防止手滑暴露到公网 */
    allowAnyInterface?: boolean;
  };
  /** 可选 TLS，例如 `tailscale cert` 生成的证书。不配时为明文 HTTP，依赖 WireGuard 加密 */
  tls?: { cert: string; key: string };
  /** 设备列表、配对码等状态文件 */
  stateDir: string;
  /** hooks 回调端口，只绑定 127.0.0.1 */
  hookPort: number;
  terminal: {
    /** tmux -L 的 socket 名，和你自己手动用的 tmux 分开 */
    tmuxSocket: string;
    session: string;
    /** tmux 会话里运行的命令 */
    command: string;
    cwd: string;
  };
  /** RFB(VNC) 服务端地址，只应在 127.0.0.1 */
  vnc?: { host: string; port: number };
  syncthing?: { url: string; apiKey?: string; apiKeyFile?: string };
  /** 事件缓冲条数（用于断线补发） */
  eventBufferSize: number;
}

export function defaultConfigPath(): string {
  return process.env.RCD_CONFIG ?? join(homedir(), ".config", "rcd", "config.json");
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export function loadConfig(path = defaultConfigPath()): DaemonConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return normalizeConfig(raw);
}

export function normalizeConfig(raw: any): DaemonConfig {
  if (!raw?.listen?.host || raw?.listen?.port == null) throw new Error("config: listen.host / listen.port 必填");
  const cfg: DaemonConfig = {
    name: raw.name ?? "remote-claude",
    listen: raw.listen,
    tls: raw.tls,
    stateDir: resolve(expandHome(raw.stateDir ?? "~/.local/state/rcd")),
    hookPort: raw.hookPort ?? 8444,
    terminal: {
      tmuxSocket: raw.terminal?.tmuxSocket ?? "rcd",
      session: raw.terminal?.session ?? "claude",
      command: raw.terminal?.command ?? "claude",
      cwd: resolve(expandHome(raw.terminal?.cwd ?? "~")),
    },
    vnc: raw.vnc,
    syncthing: raw.syncthing,
    eventBufferSize: raw.eventBufferSize ?? 5000,
  };
  const anyIf = ["0.0.0.0", "::", ""].includes(cfg.listen.host);
  if (anyIf && !cfg.listen.allowAnyInterface) {
    throw new Error(
      `config: listen.host=${cfg.listen.host} 会监听所有网卡（可能暴露到公网）。` +
        `请改成 Tailscale IP，或显式设置 listen.allowAnyInterface=true`,
    );
  }
  if (cfg.vnc && !isLoopback(cfg.vnc.host)) {
    throw new Error("config: vnc.host 必须是本机回环地址，VNC 只能经过 daemon 鉴权后访问");
  }
  return cfg;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function readSyncthingApiKey(cfg: DaemonConfig): string | undefined {
  const st = cfg.syncthing;
  if (!st) return undefined;
  if (st.apiKey) return st.apiKey;
  if (st.apiKeyFile) return readFileSync(expandHome(st.apiKeyFile), "utf8").trim();
  return undefined;
}
