import { createServer, type Server } from "node:http";
import { join } from "node:path";
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

  /** 直接设置状态（例如 GUI 回答了权限请求之后），返回是否有变化 */
  set(next: ClaudeState): boolean {
    if (next === this.state) return false;
    this.state = next;
    return true;
  }

  update(hook: string, payload?: any): ClaudeState | null {
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
      case "PermissionRequest":
        next = "awaiting_input";
        break;
      case "Notification": {
        // notification_type 区分"等你确认权限"和"空闲太久的提醒"；旧版本没有这个字段时按"等你确认"处理
        const type = payload?.notification_type;
        if (type === undefined || type === "permission_prompt" || type === "elicitation_dialog" || type === "elicitation_url_dialog")
          next = "awaiting_input";
        else if (type === "idle_prompt") next = "idle";
        break;
      }
      case "SessionEnd":
        next = "stopped";
        break;
    }
    if (next === null || next === this.state) return null;
    this.state = next;
    return next;
  }
}

export interface HookHandlers {
  onHook(payload: unknown): void;
  /**
   * 权限请求：返回要写到 hook stdout 的 JSON（GUI 做了决定），
   * 或 null（没人回答，hook 以退出码 2 结束，Claude Code 照常在终端里弹确认框）。
   */
  onPermission(payload: unknown): Promise<object | null>;
}

export function startHookServer(port: number, handlers: HookHandlers): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || (req.url !== "/hook" && req.url !== "/permission")) {
      res.writeHead(404).end();
      return;
    }
    const isPermission = req.url === "/permission";
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
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!isPermission) {
        // 先回复再处理：hook 脚本在等这个回复，越快返回越不拖慢 Claude
        res.writeHead(204).end();
        handlers.onHook(payload);
        return;
      }
      // 权限请求：这个 HTTP 请求会一直挂着，直到 GUI 回答或超时
      handlers
        .onPermission(payload)
        .then((out) => {
          if (res.writableEnded) return;
          if (out) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
          else res.writeHead(204).end();
        })
        .catch(() => !res.writableEnded && res.writeHead(204).end());
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** 权限请求等待 GUI 回答的最长时间；hook 的超时要比它长一点 */
export const PERMISSION_WAIT_MS = 110_000;
export const PERMISSION_HOOK_TIMEOUT_SEC = 120;

/** 生成 Claude Code settings.json 里的 hooks 配置片段 */
export function hooksSettings(hooksDir: string, hookPort: number): object {
  const script = (name: string) => JSON.stringify(join(hooksDir, name));
  // 端口用命令行参数而不是 VAR=x 前缀：后者是 shell 语法，Windows 上不能用
  const command = `node ${script("forward-hook.mjs")} ${hookPort}`;
  const entry = { type: "command", command, timeout: 5 };
  const toolEvents = ["PreToolUse", "PostToolUse"];
  const otherEvents = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];
  const hooks: Record<string, unknown[]> = {};
  for (const e of toolEvents) hooks[e] = [{ matcher: "*", hooks: [entry] }];
  for (const e of otherEvents) hooks[e] = [{ hooks: [entry] }];
  hooks.PermissionRequest = [
    {
      matcher: "*",
      hooks: [{ type: "command", command: `node ${script("permission-hook.mjs")} ${hookPort}`, timeout: PERMISSION_HOOK_TIMEOUT_SEC }],
    },
  ];
  return { hooks };
}
