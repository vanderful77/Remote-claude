import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { once, pairedClient, startEnv, waitFor, type Env } from "./helpers";

let env: Env | null = null;
afterEach(async () => {
  await env?.cleanup();
  env = null;
});

function collect(ws: WebSocket): { text: () => string } {
  let buf = "";
  ws.on("message", (d, isBinary) => {
    if (isBinary) buf += (d as Buffer).toString("utf8");
  });
  return { text: () => buf };
}

describe("终端（tmux attach）", () => {
  it("能输入命令看到输出；断开后会话仍在；重连后画面重绘", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");

    const ws1 = await c.openTerminal(100, 30);
    const out1 = collect(ws1);
    await once(ws1, "open");
    // 等 bash 提示符出来再输入
    await new Promise((r) => setTimeout(r, 300));
    ws1.send(Buffer.from("echo RC_$((40+2))_OK\r"), { binary: true });
    await waitFor(() => out1.text().includes("RC_42_OK"), 5000, "command output");

    ws1.close();
    await once(ws1, "close");
    // "Claude"（这里是 bash）仍在 tmux 里
    execFileSync("tmux", ["-L", env.cfg.terminal.tmuxSocket, "has-session", "-t", "=claude"]);

    // 重连：新的 tmux attach 会把当前屏幕完整画出来，包括之前的输出
    const ws2 = await c.openTerminal(100, 30);
    const out2 = collect(ws2);
    await once(ws2, "open");
    await waitFor(() => out2.text().includes("RC_42_OK"), 5000, "redraw");

    // resize 不报错
    ws2.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    ws2.close();
    c.stop();
  });

  it("中文输入输出不乱码（UTF-8）", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    const ws = await c.openTerminal(100, 30);
    const out = collect(ws);
    await once(ws, "open");
    await new Promise((r) => setTimeout(r, 300));
    ws.send(Buffer.from("echo 把文件交给Claude处理_$((1+1))\r"), { binary: true });
    await waitFor(() => out.text().includes("把文件交给Claude处理_2"), 5000, "unicode output");
    ws.close();
    c.stop();
  });

  it("令牌只能用一次", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    const token = await c.requestToken("term");
    const url = `${env.url.replace("http", "ws")}/term?token=${token}`;
    const ok = new WebSocket(url);
    await once(ok, "open");
    const again = new WebSocket(url);
    const [, res] = await once<[unknown, { statusCode: number }]>(again, "unexpected-response");
    expect(res.statusCode).toBe(401);
    again.on("error", () => {});
    ok.close();
    c.stop();
  });

  it("vnc 令牌不能用来开终端", async () => {
    env = await startEnv({ vnc: { host: "127.0.0.1", port: 1 } });
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    const token = await c.requestToken("vnc");
    const ws = new WebSocket(`${env.url.replace("http", "ws")}/term?token=${token}`);
    ws.on("error", () => {});
    const [, res] = await once<[unknown, { statusCode: number }]>(ws, "unexpected-response");
    expect(res.statusCode).toBe(401);
    c.stop();
  });

  it("tmux 会话不存在时自动重建（例如 Claude 退出后）", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    await waitFor(() => {
      try {
        execFileSync("tmux", ["-L", env!.cfg.terminal.tmuxSocket, "has-session", "-t", "=claude"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });
    execFileSync("tmux", ["-L", env.cfg.terminal.tmuxSocket, "kill-session", "-t", "=claude"]);
    const ws = await c.openTerminal(80, 24);
    let out = "";
    ws.on("message", (d) => (out += d.toString()));
    await once(ws, "open");
    // 收到画面输出，说明 attach 成功，会话已经重建
    await waitFor(() => out.length > 0, 5000, "attach output");
    expect(() => execFileSync("tmux", ["-L", env!.cfg.terminal.tmuxSocket, "has-session", "-t", "=claude"])).not.toThrow();
    ws.close();
    c.stop();
  });
});
