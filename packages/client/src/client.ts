import { EventEmitter } from "node:events";
import { sign, type KeyObject } from "node:crypto";
import WebSocket, { type ClientOptions } from "ws";
import {
  authPayload,
  Backoff,
  CloseCode,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  type ChatItem,
  type ClaudeState,
  type ClientFeature,
  type ClientMessage,
  type EventEnvelope,
  type PairRequest,
  type PairResponse,
  type ServerMessage,
  type TokenPurpose,
} from "@rc/core";

/**
 * 控制通道客户端：鉴权、自动重连、事件补发。
 *
 * 断线重连的三件事都在这里：
 * 1. 心跳：每 15 秒发 ping，45 秒没收到任何消息就判定"假活着"，主动断开重连。
 * 2. 退避：1s、2s、4s……封顶 30s，带随机抖动。
 * 3. 补发：记住最后收到的事件序号 lastSeq 和 daemon 的 bootId，重连后请求补发缺口。
 */

export interface ClientEvents {
  connected: [{ deviceName: string; claudeState: ClaudeState }];
  disconnected: [{ code: number; reason: string; retryInMs: number | null }];
  /** daemon 重启过或缺口太大：之前的时间线不连续了，UI 应清空重建 */
  reset: [];
  event: [EventEnvelope];
  /** 设备被吊销或密钥不对，不会再重连 */
  fatal: [string];
  /** 对话视图：完整快照（订阅 chat 时、Claude 换新会话时） */
  chatSnapshot: [{ sessionId: string | null; items: ChatItem[] }];
  chatAppend: [{ sessionId: string; items: ChatItem[] }];
}

export interface ChatAck {
  /** 这条消息的 id，和 chat.input 事件里的 id 对应 */
  id: string;
  status: "sent" | "queued" | "rejected";
  reason?: string;
}

export interface RemoteClientOptions {
  /** daemon 地址，例如 http://100.64.0.5:8443 */
  url: string;
  deviceId: string;
  privateKey: KeyObject;
  wsOptions?: ClientOptions;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  backoff?: Backoff;
  /** 声明本客户端的能力：GUI 用 ["chat", "permissions"]，命令行不声明 */
  features?: ClientFeature[];
}

export function toWsUrl(base: string, path: string, params?: Record<string, string | number>): string {
  const u = new URL(path, base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, String(v));
  return u.toString();
}

export async function pair(url: string, code: string, name: string, publicKey: string): Promise<PairResponse> {
  const body: PairRequest = { code, name, publicKey };
  const res = await fetch(new URL("/pair", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`配对失败: ${j.error ?? res.status}`);
  return j as PairResponse;
}

export class RemoteClient extends EventEmitter<ClientEvents> {
  private ws: WebSocket | null = null;
  private stopped = true;
  private authed = false;
  private lastRecv = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingId = 0;
  private reqId = 0;
  private pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private pendingChat = new Map<string, { resolve: (a: ChatAck) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private chatSeq = 0;
  private readonly backoff: Backoff;

  /** 补发进度。持久化它们，GUI 重启后也能接着补（目前只在内存里） */
  bootId: string | null = null;
  lastSeq = 0;
  private resuming = false;

  constructor(private readonly opts: RemoteClientOptions) {
    super();
    this.backoff = opts.backoff ?? new Backoff();
  }

  get connected(): boolean {
    return this.authed;
  }

  get url(): string {
    return this.opts.url;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, "client stop");
    this.cleanup();
  }

  /** 申请一次性令牌，用来打开 /term 或 /vnc */
  requestToken(purpose: TokenPurpose, timeoutMs = 10_000): Promise<string> {
    if (!this.authed || !this.ws) return Promise.reject(new Error("not connected"));
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("token request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "token.request", id, purpose });
    });
  }

  /**
   * 通过对话输入框给 Claude 发消息。Claude 空闲时立刻送达，忙时由 daemon 排队，
   * 等它完成当前这一轮（或你回答完权限确认）再送。
   */
  sendChat(text: string, timeoutMs = 15_000): Promise<ChatAck> {
    if (!this.authed || !this.ws) return Promise.reject(new Error("not connected"));
    const id = `c${Date.now().toString(36)}${++this.chatSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingChat.delete(id);
        reject(new Error("发送超时"));
      }, timeoutMs);
      this.pendingChat.set(id, { resolve, reject, timer });
      this.send({ type: "chat.send", id, text });
    });
  }

  /** 回答一个权限请求 */
  decidePermission(id: string, behavior: "allow" | "deny", message?: string): void {
    this.send({ type: "permission.decide", id, behavior, ...(message ? { message } : {}) });
  }

  /** 打开一个终端连接（每次调用都是一个新的 tmux attach） */
  async openTerminal(cols: number, rows: number): Promise<WebSocket> {
    const token = await this.requestToken("term");
    return new WebSocket(toWsUrl(this.opts.url, "/term", { token, cols, rows }), this.opts.wsOptions);
  }

  /** 生成 VNC WebSocket 地址（给 noVNC 用）。令牌 60 秒内有效、只能用一次 */
  async vncUrl(): Promise<string> {
    const token = await this.requestToken("vnc");
    return toWsUrl(this.opts.url, "/vnc", { token });
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    const ws = new WebSocket(toWsUrl(this.opts.url, "/ws"), this.opts.wsOptions);
    this.ws = ws;
    this.lastRecv = Date.now();

    ws.on("message", (data) => {
      this.lastRecv = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onMessage(msg);
    });
    // daemon 发来的 WebSocket ping（ws 库会自动回 pong），也算"对方还活着"
    ws.on("ping", () => (this.lastRecv = Date.now()));
    ws.on("pong", () => (this.lastRecv = Date.now()));
    ws.on("error", () => {
      /* close 事件里统一处理 */
    });
    ws.on("close", (code, reasonBuf) => this.onClose(ws, code, reasonBuf.toString()));

    const hbMs = this.opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    const hbTimeout = this.opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastRecv > hbTimeout) {
        ws.terminate(); // 触发 close -> 重连
        return;
      }
      if (this.authed) this.send({ type: "ping", id: ++this.pingId });
    }, hbMs);
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "challenge": {
        const sig = sign(null, authPayload(msg.nonce, msg.bootId), this.opts.privateKey).toString("base64");
        this.send({ type: "auth", deviceId: this.opts.deviceId, signature: sig });
        return;
      }
      case "auth.ok":
        this.authed = true;
        this.backoff.reset();
        // 注意顺序：先用"旧的" bootId 订阅，daemon 据此判断能否续上；之后再更新
        this.resuming = this.bootId !== null;
        this.send({ type: "subscribe", bootId: this.bootId, sinceSeq: this.lastSeq, features: this.opts.features ?? [] });
        this.bootId = msg.bootId;
        this.emit("connected", { deviceName: msg.deviceName, claudeState: msg.claudeState });
        return;
      case "auth.fail":
        return; // 随后会收到 close(AuthFailed)
      case "replay.reset":
        this.lastSeq = 0;
        // 第一次连接本来就是"从头开始"，不算时间线断裂
        if (this.resuming) this.emit("reset");
        return;
      case "event":
        if (msg.event.seq <= this.lastSeq) return; // 重复的，丢掉
        this.lastSeq = msg.event.seq;
        this.emit("event", msg.event);
        return;
      case "chat.snapshot":
        this.emit("chatSnapshot", { sessionId: msg.sessionId, items: msg.items });
        return;
      case "chat.append":
        this.emit("chatAppend", { sessionId: msg.sessionId, items: msg.items });
        return;
      case "chat.ack": {
        const p = this.pendingChat.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pendingChat.delete(msg.id);
        p.resolve({ id: msg.id, status: msg.status, ...(msg.reason ? { reason: msg.reason } : {}) });
        return;
      }
      case "token": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg.token);
        return;
      }
    }
  }

  private cleanup(): void {
    this.authed = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("disconnected"));
    }
    this.pending.clear();
    for (const [, p] of this.pendingChat) {
      clearTimeout(p.timer);
      p.reject(new Error("disconnected"));
    }
    this.pendingChat.clear();
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.cleanup();
    this.ws = null;
    if (code === CloseCode.AuthFailed || code === CloseCode.Revoked) {
      this.stopped = true;
      this.emit("disconnected", { code, reason, retryInMs: null });
      this.emit("fatal", code === CloseCode.Revoked ? "此设备已被吊销" : "鉴权失败（设备未配对或密钥不匹配）");
      return;
    }
    if (this.stopped) {
      this.emit("disconnected", { code, reason, retryInMs: null });
      return;
    }
    const delay = this.backoff.next();
    this.emit("disconnected", { code, reason, retryInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }
}
