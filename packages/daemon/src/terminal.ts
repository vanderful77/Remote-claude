import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import type { TermControl } from "@rc/core";

const exec = promisify(execFile);

/**
 * 终端通道：Claude 跑在 tmux 会话里，每个 /term 连接对应一个新的 `tmux attach` 进程。
 *
 * 为什么不让 daemon 直接持有 claude 的 pty：
 * - 断线重连时，需要把"当前完整的屏幕"重新画给客户端。tmux attach 天然会做这件事，
 *   自己实现就得缓存终端输出，而从缓冲中间开始回放常常落在半截转义序列上，画面错乱。
 * - 连接断了只是杀掉 attach 进程，Claude 在 tmux 里完全不受影响。
 * - 你随时可以 SSH 进去 `tmux -L rcd attach -t claude`，看到同一个会话（备用入口）。
 */

export interface TerminalConfig {
  tmuxSocket: string;
  session: string;
  command: string;
  cwd: string;
}

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

function tmux(cfg: TerminalConfig, ...args: string[]) {
  return exec("tmux", ["-L", cfg.tmuxSocket, ...args]);
}

export async function ensureSession(cfg: TerminalConfig): Promise<void> {
  try {
    await tmux(cfg, "has-session", "-t", `=${cfg.session}`);
    return;
  } catch {
    /* 会话不存在，下面创建 */
  }
  await tmux(cfg, "new-session", "-d", "-s", cfg.session, "-x", "200", "-y", "50", "-c", cfg.cwd, cfg.command);
  // 多个客户端尺寸不同时，窗口跟随最近活动的那个（tmux >= 3.1）
  await tmux(cfg, "set-option", "-g", "window-size", "latest").catch(() => {});
}

export async function killSession(cfg: TerminalConfig): Promise<void> {
  await tmux(cfg, "kill-session", "-t", `=${cfg.session}`).catch(() => {});
}

function clampSize(n: unknown, fallback: number, max: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 2 && v <= max ? v : fallback;
}

export async function attachTerminal(
  cfg: TerminalConfig,
  ws: WebSocket,
  size: { cols?: unknown; rows?: unknown },
  log: (msg: string) => void,
): Promise<void> {
  let cols = clampSize(size.cols, 120, 1000);
  let rows = clampSize(size.rows, 40, 500);
  let term: pty.IPty | null = null;
  let closed = false;
  // WebSocket 握手完成时 pty 还没起来（要先确认 tmux 会话存在）。
  // 这段时间里用户敲的键先排队，pty 就绪后按顺序写入，避免丢掉开头的输入。
  const pending: string[] = [];

  const onInput = (text: string) => (term ? term.write(text) : pending.push(text));
  const onResize = (c: unknown, r: unknown) => {
    cols = clampSize(c, cols, 1000);
    rows = clampSize(r, rows, 500);
    term?.resize(cols, rows);
  };

  // 背压：网络慢时 ws 发送缓冲会堆积，此时暂停读 pty，tmux 会自己处理（丢弃中间帧，只画最终画面）
  let paused = false;
  let drainTimer: NodeJS.Timeout | null = null;
  const stopDrain = () => {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = null;
  };

  ws.on("message", (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (isBinary) return onInput(buf.toString("utf8"));
    try {
      const msg = JSON.parse(buf.toString()) as TermControl;
      if (msg.type === "resize") onResize(msg.cols, msg.rows);
    } catch {
      /* 忽略 */
    }
  });

  ws.on("close", () => {
    closed = true;
    stopDrain();
    try {
      term?.kill();
    } catch {
      /* 已退出 */
    }
    log("terminal detached");
  });

  await ensureSession(cfg);
  if (closed) return;

  const t = pty.spawn("tmux", ["-L", cfg.tmuxSocket, "attach-session", "-t", `=${cfg.session}`], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: cfg.cwd,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });
  term = t;

  t.onData((data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(Buffer.from(data, "utf8"), { binary: true });
    if (!paused && ws.bufferedAmount > HIGH_WATER) {
      paused = true;
      t.pause();
      drainTimer = setInterval(() => {
        if (ws.bufferedAmount < LOW_WATER) {
          paused = false;
          t.resume();
          stopDrain();
        }
      }, 50);
    }
  });

  t.onExit(() => {
    stopDrain();
    // tmux attach 退出：用户按了 detach，或会话结束（例如 Claude 退出）
    if (ws.readyState === ws.OPEN) ws.close(1000, "terminal exited");
  });

  for (const text of pending.splice(0)) t.write(text);
}
