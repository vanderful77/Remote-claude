/**
 * GUI 端到端验证（手动运行：npm run test:gui）。
 *
 * 需要：Xvfb、Xvnc（TigerVNC）、tmux，以及全局可用的 Playwright + Chromium。
 *
 * 搭出来的场景：
 *   Xvnc :55      —— 扮演远程虚拟机的桌面，里面开一个 Chromium 窗口（"Claude 正在操作的浏览器"）
 *   rcd daemon    —— 真实 daemon，终端里跑 bash（代替 claude），VNC 指向 :55
 *   Xvfb :99      —— 本地显示器，Electron GUI 开在这里
 * 然后用 Playwright 驱动 GUI：配对 → 等连接 → 在终端里敲命令 → 发 hook 事件 → 发传输事件 → 截图 →
 * 断开所有连接，确认自动重连、终端重新接入。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Daemon, normalizeConfig } from "@rc/daemon";

const require = createRequire(import.meta.url);
const { _electron, chromium } = require("playwright");
const electronPath: string = require("electron");

const ROOT = resolve(import.meta.dirname, "..");
const OUT = process.env.SHOT_DIR ?? join(ROOT, "test", "screenshots");
const procs: ChildProcess[] = [];

function bg(cmd: string, args: string[]) {
  const p = spawn(cmd, args, { stdio: "ignore" });
  procs.push(p);
  return p;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function hook(port: number, payload: object) {
  await fetch(`http://127.0.0.1:${port}/hook`, { method: "POST", body: JSON.stringify(payload) });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "rc-gui-e2e-"));
  const sock = `rcgui-${process.pid}`;
  let daemon: Daemon | null = null;
  let app: any = null;
  let browser: any = null;
  try {
    console.log("启动远程桌面（Xvnc :55）和本地显示器（Xvfb :99）");
    bg("Xvnc", [":55", "-geometry", "1280x800", "-depth", "24", "-localhost", "yes", "-rfbport", "5955", "-SecurityTypes", "None", "-AlwaysShared"]);
    bg("Xvfb", [":99", "-screen", "0", "2880x1800x24"]);
    await sleep(1500);

    // "Claude 正在操作的浏览器"
    browser = await chromium.launch({
      headless: false,
      env: { ...process.env, DISPLAY: ":55" },
      args: ["--window-position=0,0", "--window-size=1280,800", "--no-first-run"],
    });
    const page = await browser.newPage({ viewport: null });
    await page.setContent(`<!doctype html><meta charset="utf-8"><title>订单后台</title>
      <body style="margin:0;font:15px system-ui,'Noto Sans CJK SC',sans-serif;background:#f6f7f9">
      <div style="background:#1f2937;color:#fff;padding:14px 24px;font-weight:600">订单管理后台 · 演示页面</div>
      <div style="padding:24px"><h2 style="margin-top:0">批量导入</h2>
      <div style="border:2px dashed #94a3b8;border-radius:10px;padding:36px;text-align:center;background:#fff">
      正在上传 <b>cleaned_orders.csv</b>（Claude 操作中）<div style="margin:16px auto;width:60%;height:10px;background:#e5e7eb;border-radius:5px">
      <div style="width:62%;height:100%;background:#2563eb;border-radius:5px"></div></div>62%</div>
      <table style="margin-top:20px;border-collapse:collapse;width:100%;background:#fff">
      <tr style="background:#e5e7eb"><th style="padding:8px;text-align:left">订单号</th><th style="text-align:left">客户</th><th style="text-align:left">金额</th></tr>
      <tr><td style="padding:8px">A-10231</td><td>华东分部</td><td>¥ 12,800</td></tr>
      <tr><td style="padding:8px">A-10232</td><td>华南分部</td><td>¥ 7,450</td></tr></table></div></body>`);

    daemon = new Daemon(
      normalizeConfig({
        name: "claude-ws",
        listen: { host: "127.0.0.1", port: 0 },
        stateDir: join(dir, "state"),
        hookPort: 0,
        terminal: { tmuxSocket: sock, session: "claude", command: "bash --norc --noprofile", cwd: dir },
        vnc: { host: "127.0.0.1", port: 5955 },
      }),
      { info: () => {}, warn: (m) => console.log("  [daemon]", m) },
    );
    await daemon.start();
    const url = `http://127.0.0.1:${daemon.port}`;
    const code = daemon.devices.createPairingCode();

    console.log("启动 Electron GUI");
    app = await _electron.launch({
      executablePath: electronPath,
      args: [join(ROOT, "packages", "gui"), "--no-sandbox", "--force-device-scale-factor=2"],
      env: { ...process.env, DISPLAY: ":99", RC_GUI_HOME: join(dir, "gui") },
    });
    const win = await app.firstWindow();
    win.on("console", (m: any) => console.log("  [renderer]", m.type(), m.text()));
    win.on("pageerror", (e: any) => console.log("  [renderer error]", e.message));
    (globalThis as any).__win = win;
    await win.setViewportSize?.({ width: 1440, height: 900 });

    console.log("配对");
    await win.waitForSelector("#pair-view:not([hidden])");
    await win.screenshot({ path: join(OUT, "gui-pair.png") });
    await win.fill("#pair-url", "http://wrong-host.invalid:1");
    await win.fill("#pair-code", code);
    await win.click("#pair-submit");
    await win.waitForFunction(() => document.getElementById("pair-error")!.textContent!.length > 0);
    check(true, "地址错误时显示错误信息");
    await win.fill("#pair-url", url);
    await win.fill("#pair-name", "我的笔记本");
    await win.click("#pair-submit");
    await win.waitForSelector("#app:not([hidden])");
    await win.waitForFunction(() => document.getElementById("conn-badge")!.textContent!.includes("已连接"), null, { timeout: 10_000 });
    check(true, "配对成功并连接");

    console.log("终端");
    await win.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("bash-"), null, { timeout: 10_000 });
    await win.click("#terminal");
    await win.keyboard.type("echo 远程 Claude 终端已接入 RC_OK_$((6*7))");
    await win.keyboard.press("Enter");
    await win.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("远程 Claude 终端已接入 RC_OK_42"), null, { timeout: 10_000 });
    check(true, "键盘输入（含中文）到达远程 tmux，输出回到界面");

    console.log("hook 事件与 Claude 状态");
    const hp = daemon.hookPort;
    await hook(hp, { hook_event_name: "SessionStart", session_id: "s1" });
    await hook(hp, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "把 inbox/orders.zip 解压、清洗，然后上传到订单后台" });
    await hook(hp, { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "unzip -o inbox/orders.zip -d work/" } });
    await hook(hp, { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Write", tool_input: { file_path: "/home/claude/workspace/outbox/cleaned_orders.csv" } });
    await hook(hp, { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "mcp__playwright__browser_file_upload", tool_input: { paths: ["outbox/cleaned_orders.csv"] } });
    await hook(hp, { hook_event_name: "Notification", session_id: "s1", message: "Claude needs your permission to use Bash" });
    await win.waitForFunction(() => document.getElementById("claude-badge")!.textContent!.includes("等待你确认"));
    check(true, "Notification hook -> Claude 状态显示为“等待你确认”");
    const tl = await win.textContent("#timeline");
    check(tl.includes("unzip -o inbox/orders.zip") && tl.includes("cleaned_orders.csv"), "时间线显示工具调用和文件路径");

    console.log("传输事件");
    const GB = 1024 ** 3;
    daemon.emitEvent({ t: "sync.item", folder: "inbox", path: "orders.zip", action: "update", phase: "started" });
    daemon.emitEvent({ t: "sync.progress", folder: "inbox", path: "orders.zip", bytesDone: 0.2 * GB, bytesTotal: 0.8 * GB });
    await sleep(600);
    daemon.emitEvent({ t: "sync.progress", folder: "inbox", path: "orders.zip", bytesDone: 0.35 * GB, bytesTotal: 0.8 * GB });
    daemon.emitEvent({ t: "sync.item", folder: "inbox", path: "contract_scan.pdf", action: "update", phase: "finished" });
    daemon.emitEvent({ t: "file.ready", folder: "inbox", path: "contract_scan.pdf" });

    console.log("远程画面");
    await win.waitForSelector("#screen canvas", { timeout: 15_000 });
    await win.waitForFunction(() => document.getElementById("screen-status")!.textContent === "", null, { timeout: 15_000 });
    await sleep(1500);
    const canvasOk = await win.evaluate(() => {
      const c = document.querySelector("#screen canvas") as HTMLCanvasElement;
      return c.width >= 1280 && c.height >= 800;
    });
    check(canvasOk, "noVNC 收到远程桌面帧（1280x800）");

    await win.screenshot({ path: join(OUT, "gui-main.png") });
    await win.click('.tab[data-tab="transfers"]');
    await win.waitForFunction(() => document.querySelectorAll(".xfer").length >= 2);
    const xfer = await win.textContent("#transfers");
    check(xfer.includes("orders.zip") && xfer.includes("%") && xfer.includes("完成"), "传输面板显示进度和已完成的文件");
    await win.screenshot({ path: join(OUT, "gui-transfers.png") });
    await win.click('.tab[data-tab="timeline"]');

    console.log("断线重连");
    for (const ws of (daemon as any).wss.clients) ws.terminate();
    for (const ws of (daemon as any).vncWss.clients) ws.terminate();
    await win.waitForFunction(() => document.getElementById("conn-badge")!.textContent!.includes("重连"), null, { timeout: 5000 });
    check(true, "断线后显示“重连中”");
    await win.waitForFunction(() => document.getElementById("conn-badge")!.textContent!.includes("已连接"), null, { timeout: 15_000 });
    await win.click("#terminal");
    await win.keyboard.type("echo reattached_$((1+1))");
    await win.keyboard.press("Enter");
    await win.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("reattached_2"), null, { timeout: 15_000 });
    check(true, "自动重连后终端重新接入，可以继续输入");
    await win.waitForFunction(() => document.getElementById("screen-status")!.textContent === "", null, { timeout: 20_000 });
    check(true, "画面自动重连");

    console.log(`\n全部通过。截图在 ${OUT}`);
  } catch (e) {
    const w = (globalThis as any).__win;
    if (w) {
      await w.screenshot({ path: join(OUT, "gui-failure.png") }).catch(() => {});
      console.log("  term-status:", await w.textContent("#term-status").catch(() => "?"));
      console.log("  screen-status:", await w.textContent("#screen-status").catch(() => "?"));
    }
    throw e;
  } finally {
    await app?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await daemon?.stop().catch(() => {});
    spawn("tmux", ["-L", sock, "kill-server"], { stdio: "ignore" });
    for (const p of procs) p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
