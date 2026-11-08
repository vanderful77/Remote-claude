import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatItem, EventEnvelope } from "@rc/core";
import { parseTranscriptLine, TranscriptTailer } from "@rc/daemon";
import { once, pairedClient, startEnv, waitFor, type Env } from "./helpers";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "daemon", "hooks");

/** 按真实会话记录的结构构造的样例行 */
const L = {
  userPrompt: (text: string, uuid = "u1") =>
    JSON.stringify({ type: "user", uuid, timestamp: "2026-11-03T10:00:00Z", isSidechain: false, message: { role: "user", content: text } }),
  assistantText: (text: string, uuid = "a1") =>
    JSON.stringify({
      type: "assistant",
      uuid,
      timestamp: "2026-11-03T10:00:01Z",
      message: { id: "msg_1", role: "assistant", content: [{ type: "text", text }] },
    }),
  toolUse: (id: string, name: string, input: object, uuid = "a2") =>
    JSON.stringify({ type: "assistant", uuid, timestamp: "2026-11-03T10:00:02Z", message: { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id, name, input }] } }),
  toolResult: (id: string, content: unknown, isError = false, uuid = "u2") =>
    JSON.stringify({ type: "user", uuid, timestamp: "2026-11-03T10:00:03Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } }),
};

describe("会话记录解析", () => {
  it("提示词、回复、工具调用、工具结果", () => {
    expect(parseTranscriptLine(L.userPrompt("把 inbox/data.csv 清洗一下"))).toEqual([
      { k: "user", id: "u1", ts: Date.parse("2026-11-03T10:00:00Z"), text: "把 inbox/data.csv 清洗一下" },
    ]);
    expect(parseTranscriptLine(L.assistantText("好的，我先看看文件结构。"))[0]).toMatchObject({ k: "assistant", text: "好的，我先看看文件结构。" });
    expect(parseTranscriptLine(L.toolUse("toolu_1", "Bash", { command: "head -5 inbox/data.csv", description: "看前几行" }))[0]).toMatchObject({
      k: "tool_use",
      toolId: "toolu_1",
      name: "Bash",
      summary: "head -5 inbox/data.csv",
    });
    expect(parseTranscriptLine(L.toolResult("toolu_1", "id,name\n1,张三", false))[0]).toMatchObject({
      k: "tool_result",
      toolId: "toolu_1",
      isError: false,
      text: "id,name\n1,张三",
    });
    // 结果也可能是内容块数组
    expect(parseTranscriptLine(L.toolResult("toolu_2", [{ type: "text", text: "ok" }, { type: "image" }]))[0]).toMatchObject({ text: "ok\n[图片]" });
  });

  it("跳过无关的行和块，不抛异常", () => {
    for (const line of [
      "not json",
      "{}",
      JSON.stringify({ type: "attachment", attachment: {} }),
      JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "x" }] } }),
      JSON.stringify({ type: "user", isSidechain: true, message: { content: "子任务" } }),
      JSON.stringify({ type: "assistant", message: null }),
    ]) {
      expect(parseTranscriptLine(line)).toEqual([]);
    }
  });

  it("中断、斜杠命令显示为系统提示", () => {
    expect(parseTranscriptLine(L.userPrompt("[Request interrupted by user]"))[0]).toMatchObject({ k: "note", text: "已中断" });
    expect(parseTranscriptLine(L.userPrompt("<command-name>/clear</command-name>\n<command-message>clear</command-message>"))[0]).toMatchObject({
      k: "note",
      text: "执行命令 /clear",
    });
  });

  it("超长工具结果被截断", () => {
    const item = parseTranscriptLine(L.toolResult("t", "x".repeat(10_000)))[0] as any;
    expect(item.text.length).toBeLessThan(4100);
  });
});

describe("TranscriptTailer", () => {
  it("只读新增部分；写了一半的行（包括被切开的汉字）等写完再解析", async () => {
    const dir = join(process.env.TMPDIR ?? "/tmp", `rc-tail-${process.pid}`, "projects", "p");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "s1.jsonl");
    writeFileSync(file, L.userPrompt("你好") + "\n");
    const t = new TranscriptTailer(20);
    const got: ChatItem[] = [];
    t.on("append", (_s, items) => got.push(...items));
    t.follow(file);
    await waitFor(() => got.length === 1);

    const line = Buffer.from(L.assistantText("收到，开始处理中文文件") + "\n");
    // 在一个汉字的中间切开（UTF-8 汉字 3 字节）
    const cut = line.indexOf(Buffer.from("开始")) + 1;
    appendFileSync(file, line.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 80));
    expect(got.length).toBe(1);
    appendFileSync(file, line.subarray(cut));
    await waitFor(() => got.length === 2);
    expect(got[1]).toMatchObject({ k: "assistant", text: "收到，开始处理中文文件" });
    expect(t.snapshot()).toMatchObject({ sessionId: "s1" });
    t.stop();
  });
});

let env: Env | null = null;
afterEach(async () => {
  await env?.cleanup();
  env = null;
});

async function hook(env: Env, payload: object) {
  await fetch(`http://127.0.0.1:${env.daemon.hookPort}/hook`, { method: "POST", body: JSON.stringify(payload) });
}

function runPermissionHook(port: number, payload: object): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HOOKS, "permission-hook.mjs"), String(port)]);
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.on("exit", (code) => resolve({ code, stdout }));
    p.stdin.end(JSON.stringify(payload));
  });
}

describe("对话视图数据", () => {
  it("hook 带来 transcript_path 后，客户端收到快照和增量", async () => {
    env = await startEnv();
    const file = join(env.dir, ".claude", "projects", "-work", "sess-abc.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, L.userPrompt("第一句") + "\n");

    const c = await pairedClient(env);
    (c as any).opts.features = ["chat"];
    const snaps: any[] = [];
    const appended: ChatItem[] = [];
    c.on("chatSnapshot", (s) => snaps.push(s));
    c.on("chatAppend", (a) => appended.push(...a.items));
    c.start();
    await once(c, "connected");
    await waitFor(() => snaps.length >= 1);
    expect(snaps[0]).toEqual({ sessionId: null, items: [] });

    await hook(env, { hook_event_name: "SessionStart", session_id: "sess-abc", transcript_path: file });
    await waitFor(() => appended.some((i) => i.k === "user"), 3000, "first line");
    appendFileSync(file, L.assistantText("第二句") + "\n");
    await waitFor(() => appended.some((i) => i.k === "assistant"), 3000, "appended line");

    // 重连后拿到的快照包含全部内容
    const c2 = await pairedClient(env, "second");
    (c2 as any).opts.features = ["chat"];
    c2.start();
    const [snap] = await once<[{ sessionId: string; items: ChatItem[] }]>(c2, "chatSnapshot");
    expect(snap.sessionId).toBe("sess-abc");
    expect(snap.items.map((i) => i.k)).toEqual(["user", "assistant"]);
    c.stop();
    c2.stop();
  });

  it("不像会话记录的路径不会被跟踪", async () => {
    env = await startEnv();
    await hook(env, { hook_event_name: "SessionStart", transcript_path: "/etc/passwd" });
    await new Promise((r) => setTimeout(r, 100));
    expect(env.daemon.transcript.snapshot().sessionId).toBeNull();
  });
});

describe("发消息给 Claude", () => {
  it("空闲时直接粘贴进终端并回车（含中文和多行）", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    const term = await c.openTerminal(120, 30);
    let out = "";
    term.on("message", (d, bin) => bin && (out += (d as Buffer).toString()));
    await once(term, "open");
    await new Promise((r) => setTimeout(r, 300));

    const r = await c.sendChat("echo 对话_$((2+3))");
    expect(r.status).toBe("sent");
    await waitFor(() => out.includes("对话_5"), 5000, "sent text executed");

    // 多行：括号粘贴让换行不被当成提前提交，回车后两行一起执行
    await c.sendChat("echo LINE_A\necho LINE_B");
    await waitFor(() => out.includes("LINE_A") && out.includes("LINE_B"), 5000, "multiline");
    term.close();
    c.stop();
  });

  it("Claude 忙或在等权限确认时排队，空闲后自动送达", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    const events: EventEnvelope[] = [];
    c.on("event", (e) => events.push(e));
    c.start();
    await once(c, "connected");
    const term = await c.openTerminal(120, 30);
    let out = "";
    term.on("message", (d, bin) => bin && (out += (d as Buffer).toString()));
    await once(term, "open");

    await hook(env, { hook_event_name: "UserPromptSubmit", prompt: "长任务" });
    await waitFor(() => env!.daemon.claudeState === "busy");
    expect((await c.sendChat("echo QUEUED_$((1+1))")).status).toBe("queued");

    // 权限确认框出现：此时绝对不能把文字送进去
    await hook(env, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "needs permission" });
    await new Promise((r) => setTimeout(r, 300));
    expect(out.includes("QUEUED_2")).toBe(false);

    await hook(env, { hook_event_name: "Stop" });
    await waitFor(() => out.includes("QUEUED_2"), 5000, "flushed after Stop");
    expect(events.filter((e) => e.body.t === "chat.input").map((e) => (e.body as any).status)).toEqual(["queued", "sent"]);
    term.close();
    c.stop();
  });

  it("送达后状态变成“工作中”并广播给客户端", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    const states: string[] = [];
    c.on("event", (e) => e.body.t === "claude.state" && states.push(e.body.state));
    c.start();
    await once(c, "connected");
    await hook(env, { hook_event_name: "SessionStart" });
    await waitFor(() => states.includes("idle"));
    expect((await c.sendChat("echo hi")).status).toBe("sent");
    await waitFor(() => states.at(-1) === "busy", 3000, "busy broadcast");
    c.stop();
  });

  it("空消息被拒绝", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    expect(await c.sendChat("   ")).toMatchObject({ status: "rejected" });
    c.stop();
  });
});

describe("权限请求", () => {
  const payload = {
    hook_event_name: "PermissionRequest",
    session_id: "s",
    tool_name: "Bash",
    tool_input: { command: "rm -rf build/", description: "清理构建目录" },
  };

  it("GUI 允许：hook 输出 allow 决定，退出码 0", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    (c as any).opts.features = ["permissions"];
    c.on("event", (e) => {
      if (e.body.t === "permission.request") c.decidePermission(e.body.id, "allow");
    });
    c.start();
    await once(c, "connected");
    const r = await runPermissionHook(env.daemon.hookPort, payload);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    c.stop();
  });

  it("GUI 拒绝：带上理由", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    (c as any).opts.features = ["permissions"];
    const seen: EventEnvelope[] = [];
    c.on("event", (e) => {
      seen.push(e);
      if (e.body.t === "permission.request") {
        expect(e.body).toMatchObject({ tool: "Bash", summary: "rm -rf build/" });
        c.decidePermission(e.body.id, "deny", "先别删，我要看一下");
      }
    });
    c.start();
    await once(c, "connected");
    const r = await runPermissionHook(env.daemon.hookPort, payload);
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "先别删，我要看一下" });
    await waitFor(() => seen.find((e) => e.body.t === "permission.resolved"));
    c.stop();
  });

  it("没有能回答权限的客户端在线：立刻退出码 2，交还给终端确认框", async () => {
    env = await startEnv();
    const c = await pairedClient(env); // 命令行客户端，不声明 permissions
    c.start();
    await once(c, "connected");
    const t0 = Date.now();
    const r = await runPermissionHook(env.daemon.hookPort, payload);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(Date.now() - t0).toBeLessThan(2000);
    c.stop();
  });

  it("GUI 在线但没人回答：超时后退出码 2", async () => {
    env = await startEnv(); // 测试里等待上限是 3 秒
    const c = await pairedClient(env);
    (c as any).opts.features = ["permissions"];
    const seen: EventEnvelope[] = [];
    c.on("event", (e) => seen.push(e));
    c.start();
    await once(c, "connected");
    const r = await runPermissionHook(env.daemon.hookPort, payload);
    expect(r.code).toBe(2);
    expect(seen.find((e) => e.body.t === "permission.resolved")?.body).toMatchObject({ by: "timeout" });
    c.stop();
  });

  it("daemon 没运行：退出码 2", async () => {
    const r = await runPermissionHook(1, payload);
    expect(r.code).toBe(2);
  });
});
