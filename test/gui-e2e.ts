/**
 * GUI 端到端验证（手动运行：npm run test:gui）。
 *
 * 需要：Xvfb、Xvnc（TigerVNC）、tmux，以及全局可用的 Playwright + Chromium。
 *
 * 搭出来的场景：
 *   Xvnc :55      —— 扮演远程虚拟机的桌面，里面开一个 Chromium 窗口（"Claude 正在操作的浏览器"）
 *   rcd daemon    —— 真实 daemon，终端里跑 bash（代替 claude），VNC 指向 :55
 *   Xvfb :99      —— 本地显示器，Electron GUI 开在这里
 *   一个按真实格式写的会话记录文件 —— 代替 Claude Code 写的 .jsonl
 * Syncthing 用 daemon.emitEvent 模拟（远程收到文件的事件）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function runPermissionHook(port: number, payload: object): Promise<{ code: number | null; stdout: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [join(ROOT, "packages/daemon/hooks/permission-hook.mjs"), String(port)]);
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.on("exit", (code) => res({ code, stdout }));
    p.stdin.end(JSON.stringify(payload));
  });
}

// 按真实会话记录结构写的几行
let uuid = 0;
const T = (type: string, content: unknown) =>
  JSON.stringify({ type, uuid: `e2e-${++uuid}`, timestamp: new Date().toISOString(), isSidechain: false, message: { role: type, content } }) + "\n";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "rc-gui-e2e-"));
  const sock = `rcgui-${process.pid}`;
  const local = join(dir, "local-sync");
  mkdirSync(join(local, "outbox"), { recursive: true });
  const transcript = join(dir, ".claude", "projects", "-home-claude-workspace", "sess-demo.jsonl");
  mkdirSync(join(transcript, ".."), { recursive: true });
  let daemon: Daemon | null = null;
  let app: any = null;
  let browser: any = null;
  try {
    console.log("启动远程桌面（Xvnc :55）和本地显示器（Xvfb :99）");
    bg("Xvnc", [":55", "-geometry", "1280x800", "-depth", "24", "-localhost", "yes", "-rfbport", "5955", "-SecurityTypes", "None", "-AlwaysShared"]);
    bg("Xvfb", [":99", "-screen", "0", "2880x1800x24"]);
    await sleep(1500);

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
      正在上传 <b>cleaned_orders.xlsx</b>（Claude 操作中）<div style="margin:16px auto;width:60%;height:10px;background:#e5e7eb;border-radius:5px">
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
      { permissionWaitMs: 20_000 },
    );
    await daemon.start();
    const hp = daemon.hookPort;
    const url = `http://127.0.0.1:${daemon.port}`;
    const code = daemon.devices.createPairingCode();

    console.log("启动 Electron GUI 并配对");
    app = await _electron.launch({
      executablePath: electronPath,
      args: [join(ROOT, "packages", "gui"), "--no-sandbox", "--force-device-scale-factor=2"],
      env: { ...process.env, DISPLAY: ":99", RC_GUI_HOME: join(dir, "gui") },
    });
    const win = await app.firstWindow();
    win.on("pageerror", (e: any) => console.log("  [renderer error]", e.message));
    (globalThis as any).__win = win;
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
    await win.evaluate((folder: string) => (window as any).rc.saveSettings({ localFolder: folder }), local);

    console.log("对话视图");
    writeFileSync(
      transcript,
      T("user", "inbox 里有一份 8 月的订单导出，帮我清洗一下：手机号统一成 11 位，金额去掉货币符号，然后上传到订单后台。") +
        T("assistant", [{ type: "text", text: "好的。我先看一下文件结构，确认有哪些列。" }]) +
        T("assistant", [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "python3 -c \"import pandas as pd; print(pd.read_excel('inbox/orders_aug.xlsx').head())\"" } }]) +
        T("user", [{ type: "tool_result", tool_use_id: "tu1", content: "   订单号   客户      手机号        金额\n0  A-10231  华东分部  138-0013-8000  ¥12,800\n1  A-10232  华南分部  +86 13900139000  ¥7,450", is_error: false }]) +
        T("assistant", [{ type: "tool_use", id: "tu2", name: "Write", input: { file_path: "/home/claude/workspace/work/clean.py", content: "import pandas as pd\n..." } }]) +
        T("user", [{ type: "tool_result", tool_use_id: "tu2", content: "File created successfully", is_error: false }]) +
        T("assistant", [
          {
            type: "text",
            text: "清洗完成，结果在 `outbox/cleaned_orders.xlsx`。\n\n| 项目 | 处理前 | 处理后 |\n|---|---|---|\n| 手机号格式 | 4 种 | 统一 11 位 |\n| 金额 | 带 ¥ 和逗号 | 纯数字 |\n\n共 **1,284** 行，其中 3 行手机号无法识别，已单独列在 `outbox/unparsed.csv`。接下来我去订单后台上传。",
          },
        ]),
    );
    await hook(hp, { hook_event_name: "SessionStart", session_id: "sess-demo", transcript_path: transcript });
    await win.waitForFunction(() => document.querySelectorAll("#chat .msg.assistant").length >= 2, null, { timeout: 8000 });
    const chatText = await win.textContent("#chat .chat-list");
    check(chatText.includes("8 月的订单导出") && chatText.includes("清洗完成"), "会话记录渲染成对话（提示词 + 回复）");
    check(await win.$("#chat .md table"), "回复里的 Markdown 表格被渲染");
    check((await win.$$("#chat details.tool")).length === 2 && chatText.includes("完成"), "工具调用折叠显示，并配上了结果");

    console.log("附件：文件选择框");
    const src = join(dir, "orders_aug.xlsx");
    writeFileSync(src, Buffer.alloc(300_000, 7));
    await win.setInputFiles("#file-input", src);
    await win.waitForSelector("#composer .chip");
    await sleep(300);
    check(existsSync(join(local, "inbox", "orders_aug.xlsx")), "文件被复制进本地同步文件夹的 inbox/");
    daemon.emitEvent({ t: "sync.item", folder: "workspace", path: "inbox/orders_aug.xlsx", action: "update", phase: "started" });
    daemon.emitEvent({ t: "sync.progress", folder: "workspace", path: "inbox/orders_aug.xlsx", bytesDone: 135_000, bytesTotal: 300_000 });
    await win.waitForFunction(() => document.querySelector("#composer .chip")?.textContent?.includes("传输中 45%"));
    check(true, "附件显示远程接收进度");

    console.log("附件：粘贴截图、拖入");
    await win.evaluate(() => {
      // 1x1 PNG
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([png], "image.png", { type: "image/png" }));
      document.querySelector("#composer textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await win.waitForFunction(() => document.querySelectorAll("#composer .chip").length === 2);
    const shot = readdirSync(join(local, "inbox")).find((n) => n.startsWith("截图-"));
    check(shot && shot.endsWith(".png"), `粘贴的截图存成 inbox/${shot}`);
    await win.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["合同正文"], "合同草稿.txt", { type: "text/plain" }));
      window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await win.waitForFunction(() => document.querySelectorAll("#composer .chip").length === 3);
    check(existsSync(join(local, "inbox", "合同草稿.txt")), "拖入的文件出现在 inbox/");
    await win.click('#composer .chip:has-text("合同草稿") .chip-x');
    await win.waitForFunction(() => document.querySelectorAll("#composer .chip").length === 2);
    check(true, "附件可以移除");

    console.log("发送：附件未就绪时等待，就绪后自动发送");
    await win.fill("#composer textarea", "这是 8 月订单和后台报错的截图，按上次的规则清洗");
    await win.press("#composer textarea", "Enter");
    await win.waitForFunction(() => document.querySelector("#composer .send")!.textContent!.includes("传完后自动发送"));
    check(true, "附件还没传完：按钮变成“传完后自动发送”");
    await win.screenshot({ path: join(OUT, "gui-chat-attach.png") });
    const shotRel = `inbox/${shot}`;
    daemon.emitEvent({ t: "file.ready", folder: "workspace", path: "inbox/orders_aug.xlsx", absPath: "/home/claude/workspace/inbox/orders_aug.xlsx" });
    daemon.emitEvent({ t: "file.ready", folder: "workspace", path: shotRel, absPath: `/home/claude/workspace/${shotRel}` });
    await win.waitForFunction(() => document.querySelectorAll("#composer .chip").length === 0, null, { timeout: 8000 });
    check(true, "两个附件就绪后自动发送，输入框清空");
    await win.click('.ltab[data-ltab="term"]');
    await win.waitForFunction(
      () => document.querySelector(".xterm-rows")?.textContent?.includes("@/home/claude/workspace/inbox/orders_aug.xlsx"),
      null,
      { timeout: 8000 },
    );
    check(true, "消息（含 @文件引用）被粘贴进远程终端并回车");
    await win.click('.ltab[data-ltab="chat"]');

    console.log("Claude 忙时排队");
    await hook(hp, { hook_event_name: "UserPromptSubmit", session_id: "sess-demo", transcript_path: transcript, prompt: "x" });
    await win.waitForFunction(() => document.getElementById("claude-badge")!.textContent!.includes("工作中"));
    await win.fill("#composer textarea", "上传完记得截图给我看");
    await win.press("#composer textarea", "Enter");
    await win.waitForFunction(() => [...document.querySelectorAll("#chat .msg.pending")].some((e) => e.textContent!.includes("排队中")));
    check(true, "Claude 工作中：消息显示“排队中”");

    console.log("权限请求");
    appendFileSync(
      transcript,
      T("assistant", [{ type: "text", text: "文件已经准备好。上传前我需要先清理临时目录。" }]) +
        T("assistant", [{ type: "tool_use", id: "tu3", name: "Bash", input: { command: "rm -rf work/tmp_export/" } }]),
    );
    const permDone = runPermissionHook(hp, {
      hook_event_name: "PermissionRequest",
      session_id: "sess-demo",
      transcript_path: transcript,
      tool_name: "Bash",
      tool_input: { command: "rm -rf work/tmp_export/", description: "清理导出的临时文件" },
    });
    await win.waitForSelector("#chat .perm-card", { timeout: 8000 });
    await win.waitForFunction(() => document.getElementById("claude-badge")!.textContent!.includes("等待你确认"));
    check(true, "权限请求显示为卡片，Claude 状态变成“等待你确认”");
    await sleep(800);
    await win.screenshot({ path: join(OUT, "gui-chat.png") });
    await win.click("#chat .perm-allow");
    const perm = await permDone;
    check(perm.code === 0 && JSON.parse(perm.stdout).hookSpecificOutput.decision.behavior === "allow", "点“允许”后 hook 返回 allow 决定");
    await win.waitForFunction(() => !document.querySelector("#chat .perm-card"));
    check(true, "回答后卡片消失");

    await hook(hp, { hook_event_name: "Stop", session_id: "sess-demo", transcript_path: transcript });
    await win.click('.ltab[data-ltab="term"]');
    await win.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.includes("上传完记得截图给我看"), null, { timeout: 8000 });
    check(true, "Claude 空闲后，排队的消息自动送达终端");
    await win.click('.ltab[data-ltab="chat"]');

    console.log("文件面板");
    writeFileSync(join(local, "outbox", "cleaned_orders.xlsx"), Buffer.alloc(1_350_000, 1));
    writeFileSync(join(local, "outbox", "unparsed.csv"), "订单号,手机号\nA-10301,12345\n");
    await win.click('.tab[data-tab="files"]');
    await win.waitForFunction(() => document.getElementById("files")!.textContent!.includes("cleaned_orders.xlsx"));
    const filesText = await win.textContent("#files");
    check(filesText.includes("Claude 的产出") && filesText.includes("orders_aug.xlsx"), "文件面板列出 outbox/ 和 inbox/");
    const draggable = await win.getAttribute("#files .file-row", "draggable");
    check(draggable === "true", "文件行可以拖出");
    await win.screenshot({ path: join(OUT, "gui-files.png") });

    console.log("远程画面与断线重连");
    await win.waitForSelector("#screen canvas", { timeout: 15_000 });
    await win.waitForFunction(() => document.getElementById("screen-status")!.textContent === "", null, { timeout: 15_000 });
    for (const ws of (daemon as any).wss.clients) ws.terminate();
    await win.waitForFunction(() => document.getElementById("conn-badge")!.textContent!.includes("重连"), null, { timeout: 5000 });
    await win.waitForFunction(() => document.getElementById("conn-badge")!.textContent!.includes("已连接"), null, { timeout: 15_000 });
    await win.waitForFunction(() => document.querySelectorAll("#chat .msg.assistant").length >= 3, null, { timeout: 8000 });
    check(true, "断线重连后对话视图从快照恢复");

    console.log(`\n全部通过。截图在 ${OUT}`);
  } catch (e) {
    const w = (globalThis as any).__win;
    if (w) await w.screenshot({ path: join(OUT, "gui-failure.png") }).catch(() => {});
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
