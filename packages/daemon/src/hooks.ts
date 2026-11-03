import { createServer, type Server } from "node:http";
import type { ClaudeState, EventBody } from "@rc/core";

/**
 * 接收 Claude Code hooks 的回调。
 *
 * Claude Code 每做一步（提交提示词、调用工具前后、等待确认、一轮结束……）都会运行
 * settings.json 里配置的 hook 命令，并把一段 JSON 从 stdin 传进去。
 * 我们的 hook 脚本（hooks/forward-hook.mjs）只做一件事：把这段 JSON POST 到这里，然后立刻退出。
 *
 * 这个端口只绑定 127.0.0.1：只有同一台机器（同一个隔离单元）里的进程能发事件。
 */

const MAX_BODY = 1024 * 1024;
const MAX_STRING = 2000;

/** 去掉大字段：tool_response 可能是整份文件内容，不进事件流 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + `…(+${value.length - MAX_STRING})` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "tool_response") {
      out[k] = { omitted: true };
      continue;
    }
    out[k] = sanitize(v, depth + 1);
  }
  return out;
}

function oneLine(s: unknown, max = 200): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

export function hookToEvent(p: any): EventBody {
  const hook = String(p?.hook_event_name ?? "unknown");
  const input = p?.tool_input ?? {};
  const summary =
    oneLine(input.file_path) ??
    oneLine(input.notebook_path) ??
    oneLine(input.command) ??
    oneLine(input.url) ??
    oneLine(input.pattern) ??
    oneLine(p?.prompt) ??
    oneLine(p?.message);
  return {
    t: "claude.hook",
    hook,
    ...(p?.session_id ? { sessionId: String(p.session_id) } : {}),
    ...(p?.tool_name ? { tool: String(p.tool_name) } : {}),
    ...(summary ? { summary } : {}),
    payload: sanitize(p),
  };
}

/**
 * 从 hook 序列推断 Claude 当前状态。这是推断，不是 Claude 自己报告的：
 * 例如 Notification 既可能是"等你确认权限"，也可能是"空闲太久的提醒"，这里统一当作 awaiting_input。
 */
export class ClaudeStateTracker {
  state: ClaudeState = "unknown";

  update(hook: string): ClaudeState | null {
    let next: ClaudeState | null = null;
    switch (hook) {
      case "SessionStart":
      case "Stop":
        next = "idle";
        break;
      case "UserPromptSubmit":
      case "PreToolUse":
      case "PostToolUse":
        next = "busy";
        break;
      case "Notification":
        next = "awaiting_input";
        break;
      case "SessionEnd":
        next = "stopped";
        break;
    }
    if (next === null || next === this.state) return null;
    this.state = next;
    return next;
  }
}

export function startHookServer(
  port: number,
  onHook: (payload: unknown) => void,
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/hook") {
      res.writeHead(404).end();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      // 先回复再处理：hook 脚本在等这个回复，越快返回越不拖慢 Claude
      res.writeHead(204).end();
      try {
        onHook(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        /* 忽略坏数据 */
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** 生成 Claude Code settings.json 里的 hooks 配置片段 */
export function hooksSettings(scriptPath: string, hookPort: number): object {
  // 端口用命令行参数而不是 VAR=x 前缀：后者是 shell 语法，Windows 上不能用
  const command = `node ${JSON.stringify(scriptPath)} ${hookPort}`;
  const entry = { type: "command", command, timeout: 5 };
  const toolEvents = ["PreToolUse", "PostToolUse"];
  const otherEvents = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];
  const hooks: Record<string, unknown[]> = {};
  for (const e of toolEvents) hooks[e] = [{ matcher: "*", hooks: [entry] }];
  for (const e of otherEvents) hooks[e] = [{ hooks: [entry] }];
  return { hooks };
}
