import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { EventEnvelope } from "@rc/core";
import { ClaudeStateTracker, hooksSettings, hookToEvent, sanitize } from "@rc/daemon";
import { once, pairedClient, startEnv, waitFor, type Env } from "./helpers";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "daemon", "hooks", "forward-hook.mjs");

function runHook(port: number, payload: unknown): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, String(port)]);
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.on("exit", (code) => resolve({ code, stdout }));
    p.stdin.end(JSON.stringify(payload));
  });
}

describe("hook 数据处理", () => {
  it("提取工具名和摘要，丢弃 tool_response 大字段", () => {
    const ev = hookToEvent({
      hook_event_name: "PostToolUse",
      session_id: "s1",
      tool_name: "Write",
      tool_input: { file_path: "/workspace/out/report.xlsx", content: "x".repeat(10_000) },
      tool_response: { content: "huge" },
    });
    expect(ev).toMatchObject({ t: "claude.hook", hook: "PostToolUse", tool: "Write", summary: "/workspace/out/report.xlsx" });
    const p = (ev as any).payload;
    expect(p.tool_response).toEqual({ omitted: true });
    expect(p.tool_input.content.length).toBeLessThan(2100);
  });

  it("sanitize 限制深度", () => {
    expect(sanitize({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: "[…]" } } } });
  });

  it("状态推断", () => {
    const t = new ClaudeStateTracker();
    expect(t.update("SessionStart")).toBe("idle");
    expect(t.update("UserPromptSubmit")).toBe("busy");
    expect(t.update("PreToolUse")).toBeNull(); // 状态没变不重复报
    expect(t.update("Notification")).toBe("awaiting_input"); // 旧版本没有 notification_type
    expect(t.update("Notification", { notification_type: "idle_prompt" })).toBe("idle");
    expect(t.update("Notification", { notification_type: "permission_prompt" })).toBe("awaiting_input");
    expect(t.update("Notification", { notification_type: "auth_success" })).toBeNull();
    expect(t.update("PostToolUse")).toBe("busy");
    expect(t.update("Stop")).toBe("idle");
    expect(t.update("SomethingNew")).toBeNull();
  });

  it("生成的 settings 片段格式", () => {
    const s = hooksSettings("/opt/rcd/hooks", 8444) as any;
    expect(s.hooks.PreToolUse[0].matcher).toBe("*");
    expect(s.hooks.Stop[0].hooks[0].command).toBe('node "/opt/rcd/hooks/forward-hook.mjs" 8444');
    expect(s.hooks.PermissionRequest[0].hooks[0]).toMatchObject({ command: 'node "/opt/rcd/hooks/permission-hook.mjs" 8444', timeout: 120 });
  });
});

let env: Env | null = null;
afterEach(async () => {
  await env?.cleanup();
  env = null;
});

describe("hook 脚本 -> daemon -> 客户端", () => {
  it("事件和状态变化送达客户端", async () => {
    env = await startEnv();
    const c = await pairedClient(env);
    const got: EventEnvelope[] = [];
    c.on("event", (e) => got.push(e));
    c.start();
    await once(c, "connected");

    const r = await runHook(env.daemon.hookPort, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "python clean.py inbox/data.csv" },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(""); // 绝不影响 Claude 的决定

    await waitFor(() => got.find((e) => e.body.t === "claude.state"), 3000, "state event");
    expect(got.find((e) => e.body.t === "claude.hook")?.body).toMatchObject({ tool: "Bash", summary: "python clean.py inbox/data.csv" });
    expect(got.find((e) => e.body.t === "claude.state")?.body).toMatchObject({ state: "busy" });
    c.stop();
  });

  it("daemon 没运行时，hook 脚本也会立刻成功退出（不拖住 Claude）", async () => {
    const t0 = Date.now();
    const r = await runHook(1, { hook_event_name: "Stop" });
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});
