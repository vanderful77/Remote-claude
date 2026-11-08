import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  authPayload,
  CloseCode,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SyncthingWatcher,
  type ClaudeState,
  type ClientFeature,
  type ClientMessage,
  type EventBody,
  type PairRequest,
  type PairResponse,
  type ServerMessage,
} from "@rc/core";
import { readSyncthingApiKey, type DaemonConfig } from "./config";
import { DeviceStore } from "./devices";
import { EventLog } from "./eventlog";
import { ClaudeStateTracker, hookToEvent, PERMISSION_WAIT_MS, sanitize, startHookServer } from "./hooks";
import { attachTerminal, ensureSession, sendText } from "./terminal";
import { isTranscriptPath, TranscriptTailer } from "./transcript";
import { TokenStore } from "./tokens";
import { bridgeVnc } from "./vnc";

export const DAEMON_VERSION = "0.1.0";

interface Conn {
  ws: WebSocket;
  deviceId: string | null;
  kind: "control" | "term" | "vnc";
  lastSeen: number;
  /** 控制连接是否已完成补发、开始接收实时事件 */
  subscribed: boolean;
  features: Set<ClientFeature>;
}

export interface DaemonOptions {
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  /** 权限请求等 GUI 回答的最长时间 */
  permissionWaitMs?: number;
  /** 粘贴到 Claude 输入框后、按回车前的等待 */
  chatSettleMs?: number;
}

interface PendingPermission {
  resolve: (d: { behavior: "allow" | "deny"; message?: string } | null) => void;
}

const MAX_CHAT_TEXT = 100_000;
const MAX_CHAT_QUEUE = 20;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

const consoleLogger: Logger = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN ${m}`),
};

export class Daemon {
  readonly events: EventLog;
  readonly devices: DeviceStore;
  private readonly tokens = new TokenStore();
  private readonly claude = new ClaudeStateTracker();
  private readonly conns = new Set<Conn>();
  private server: Server | null = null;
  private hookServer: Server | null = null;
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  /** noVNC 会请求 "binary" 子协议 */
  private vncWss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });
  private syncthing: SyncthingWatcher | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private devicesVersion = 0;
  readonly transcript = new TranscriptTailer();
  private pendingPermissions = new Map<string, PendingPermission>();
  private chatQueue: { id: string; text: string }[] = [];
  private flushing = false;
  private readonly opts: Required<DaemonOptions>;

  constructor(
    readonly cfg: DaemonConfig,
    private readonly log: Logger = consoleLogger,
    opts: DaemonOptions = {},
  ) {
    this.events = new EventLog(cfg.eventBufferSize);
    this.devices = new DeviceStore(cfg.stateDir);
    this.opts = {
      heartbeatMs: opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS,
      permissionWaitMs: opts.permissionWaitMs ?? PERMISSION_WAIT_MS,
      chatSettleMs: opts.chatSettleMs ?? 150,
    };
  }

  get claudeState(): ClaudeState {
    return this.claude.state;
  }

  /** 实际监听的端口（配置端口为 0 时由系统分配，测试用） */
  get port(): number {
    const addr = this.server?.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  get hookPort(): number {
    const addr = this.hookServer?.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  emitEvent(body: EventBody): void {
    this.events.append(body);
  }

  async start(): Promise<void> {
    this.events.on("append", (ev) => {
      const msg: ServerMessage = { type: "event", event: ev };
      const text = JSON.stringify(msg);
      for (const c of this.conns) {
        if (c.kind === "control" && c.deviceId && c.subscribed && c.ws.readyState === c.ws.OPEN) c.ws.send(text);
      }
    });

    this.hookServer = await startHookServer(this.cfg.hookPort, {
      onHook: (p) => this.onHook(p),
      onPermission: (p) => this.onPermission(p),
    });

    // 对话视图：会话记录有变化就推给订阅了 chat 的客户端
    this.transcript.on("snapshot", (sessionId, items) => this.broadcastChat({ type: "chat.snapshot", sessionId, items }));
    this.transcript.on("append", (sessionId, items) => this.broadcastChat({ type: "chat.append", sessionId, items }));
    try {
      const last = JSON.parse(readFileSync(join(this.cfg.stateDir, "transcript.json"), "utf8")).path;
      if (isTranscriptPath(last)) this.transcript.follow(last);
    } catch {
      /* 还没有记录过 */
    }

    const handler = (req: IncomingMessage, res: ServerResponse) => this.onHttp(req, res);
    this.server = this.cfg.tls
      ? createHttpsServer({ cert: readFileSync(this.cfg.tls.cert), key: readFileSync(this.cfg.tls.key) }, handler)
      : createHttpServer(handler);
    this.server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.cfg.listen.port, this.cfg.listen.host, () => resolve());
    });

    const apiKey = readSyncthingApiKey(this.cfg);
    if (this.cfg.syncthing && apiKey) {
      this.syncthing = new SyncthingWatcher({ url: this.cfg.syncthing.url, apiKey });
      this.syncthing.on("event", (e) => this.emitEvent(e));
      this.syncthing.start();
    } else if (this.cfg.syncthing) {
      this.log.warn("syncthing 已配置但没有 apiKey / apiKeyFile，跳过");
    }

    this.devicesVersion = this.devices.version();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);

    // 预先建好 tmux 会话：daemon 一启动 Claude 就在跑，不必等第一个客户端连上
    ensureSession(this.cfg.terminal).catch((e) => this.log.warn(`tmux 会话创建失败: ${e.message}`));

    this.emitEvent({ t: "daemon.started", version: DAEMON_VERSION });
    const scheme = this.cfg.tls ? "https" : "http";
    this.log.info(`rcd listening on ${scheme}://${this.cfg.listen.host}:${this.port}, hooks on 127.0.0.1:${this.hookPort}`);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.transcript.stop();
    for (const p of this.pendingPermissions.values()) p.resolve(null);
    for (const c of this.conns) c.ws.close(CloseCode.Shutdown, "daemon shutting down");
    await this.syncthing?.stop();
    await new Promise<void>((r) => (this.hookServer ? this.hookServer.close(() => r()) : r()));
    await new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
      this.server.closeAllConnections?.();
    });
  }

  // ---------- hooks ----------

  private onHook(payload: unknown): void {
    const p = payload as any;
    const ev = hookToEvent(p);
    this.emitEvent(ev);
    if (ev.t === "claude.hook") {
      const st = this.claude.update(ev.hook, p);
      if (st) this.onStateChanged(st, ev.hook);
    }
    // 每个 hook 都带着当前会话记录的路径：Claude 开了新会话（/clear、重启）时自动切换
    if (isTranscriptPath(p?.transcript_path) && p.transcript_path !== this.transcriptPathSaved) {
      this.transcriptPathSaved = p.transcript_path;
      this.transcript.follow(p.transcript_path);
      try {
        writeFileSync(join(this.cfg.stateDir, "transcript.json"), JSON.stringify({ path: p.transcript_path }));
      } catch {
        /* 只是为了 daemon 重启后能恢复，失败无妨 */
      }
    }
  }

  private transcriptPathSaved: string | null = null;

  private setState(st: ClaudeState, reason: string) {
    if (this.claude.set(st)) this.onStateChanged(st, reason);
  }

  private onStateChanged(st: ClaudeState, reason: string) {
    this.emitEvent({ t: "claude.state", state: st, reason });
    if (st === "idle") void this.flushChat();
  }

  // ---------- 权限请求（PermissionRequest hook） ----------

  private hasFeature(f: ClientFeature): boolean {
    for (const c of this.conns) if (c.kind === "control" && c.deviceId && c.features.has(f) && c.ws.readyState === c.ws.OPEN) return true;
    return false;
  }

  private async onPermission(payload: unknown): Promise<object | null> {
    const p = payload as any;
    this.onHook({ ...p, hook_event_name: "PermissionRequest" });
    // 没有能回答的界面在线：立刻放手，Claude Code 照常在终端里弹确认框
    if (!this.hasFeature("permissions")) return null;

    const id = randomUUID();
    const ev = hookToEvent(p);
    this.emitEvent({
      t: "permission.request",
      id,
      tool: String(p?.tool_name ?? "tool"),
      ...(ev.t === "claude.hook" && ev.summary ? { summary: ev.summary } : {}),
      input: sanitize(p?.tool_input),
    });
    const decision = await new Promise<{ behavior: "allow" | "deny"; message?: string } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), this.opts.permissionWaitMs);
      this.pendingPermissions.set(id, {
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
      });
    });
    this.pendingPermissions.delete(id);
    if (!decision) {
      this.emitEvent({ t: "permission.resolved", id, by: "timeout" });
      return null;
    }
    this.emitEvent({ t: "permission.resolved", id, behavior: decision.behavior, by: "gui" });
    this.setState("busy", "PermissionDecision");
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision:
          decision.behavior === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: decision.message || "用户在 Remote Claude 界面里拒绝了这个操作" },
      },
    };
  }

  // ---------- 对话输入 ----------

  /**
   * 能不能现在就把消息送进 Claude 的输入框：
   * - idle：一轮结束，在等你输入，可以
   * - unknown：没收到过 hook（可能没配 hooks），只能直接送
   * - busy / awaiting_input / stopped：排队。尤其是 awaiting_input——这时终端里是权限确认框，
   *   送进去的文字和回车会被当成对确认框的回答。
   */
  private canDeliver(): boolean {
    return this.claude.state === "idle" || this.claude.state === "unknown";
  }

  async chatSend(id: string, text: string): Promise<{ status: "sent" | "queued" | "rejected"; reason?: string }> {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text.trim()) return { status: "rejected", reason: "消息为空" };
    if (text.length > MAX_CHAT_TEXT) return { status: "rejected", reason: "消息太长" };
    if (this.chatQueue.length >= MAX_CHAT_QUEUE) return { status: "rejected", reason: "排队的消息太多" };
    if (this.canDeliver() && !this.chatQueue.length && !this.flushing) {
      try {
        await this.deliver(id, text);
        return { status: "sent" };
      } catch (e) {
        this.emitEvent({ t: "chat.input", id, status: "dropped", preview, reason: (e as Error).message });
        return { status: "rejected", reason: (e as Error).message };
      }
    }
    this.chatQueue.push({ id, text });
    this.emitEvent({ t: "chat.input", id, status: "queued", preview });
    return { status: "queued" };
  }

  private async deliver(id: string, text: string) {
    await sendText(this.cfg.terminal, text, this.opts.chatSettleMs);
    // 乐观地认为 Claude 开始工作了（随后的 UserPromptSubmit hook 会确认）。
    // 必须走 setState 广播出去：只改内部状态的话，界面会一直显示"空闲"
    if (this.claude.state === "idle") this.setState("busy", "ChatSent");
    this.emitEvent({ t: "chat.input", id, status: "sent", preview: text.replace(/\s+/g, " ").trim().slice(0, 80) });
  }

  private async flushChat() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.chatQueue.length && this.canDeliver()) {
        const next = this.chatQueue.shift()!;
        try {
          await this.deliver(next.id, next.text);
        } catch (e) {
          this.emitEvent({ t: "chat.input", id: next.id, status: "dropped", preview: next.text.slice(0, 80), reason: (e as Error).message });
        }
        // 没有 hooks 时状态一直是 unknown：每条之间留点间隔，别把几条消息粘在一起
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      this.flushing = false;
    }
  }

  private broadcastChat(msg: ServerMessage) {
    const text = JSON.stringify(msg);
    for (const c of this.conns)
      if (c.kind === "control" && c.subscribed && c.features.has("chat") && c.ws.readyState === c.ws.OPEN) c.ws.send(text);
  }

  // ---------- HTTP ----------

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/pair") {
      this.onPair(req, res);
      return;
    }
    res.writeHead(404).end();
  }

  private onPair(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
      if (body.length > 16 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        const r = JSON.parse(body) as PairRequest;
        if (typeof r.code !== "string" || typeof r.publicKey !== "string") throw new Error("bad request");
        const device = this.devices.pair(r.code, String(r.name ?? ""), r.publicKey);
        this.log.info(`paired device ${device.id} (${device.name}) from ${req.socket.remoteAddress}`);
        const out: PairResponse = { deviceId: device.id, daemonName: this.cfg.name };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (e) {
        this.log.warn(`pairing failed from ${req.socket.remoteAddress}: ${(e as Error).message}`);
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  }

  // ---------- WebSocket ----------

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://x");
    const reject = (code: number) => {
      socket.write(`HTTP/1.1 ${code} ${code === 401 ? "Unauthorized" : "Not Found"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    if (url.pathname === "/ws") {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onControl(ws));
      return;
    }
    if (url.pathname === "/term") {
      const deviceId = this.tokens.consume(url.searchParams.get("token"), "term");
      if (!deviceId) return reject(401);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.track(ws, "term", deviceId);
        this.log.info(`terminal attached by ${deviceId}`);
        attachTerminal(this.cfg.terminal, ws, { cols: url.searchParams.get("cols"), rows: url.searchParams.get("rows") }, (m) =>
          this.log.info(m),
        ).catch((e) => {
          this.log.warn(`terminal attach failed: ${e.message}`);
          ws.close(1011, "attach failed");
        });
      });
      return;
    }
    if (url.pathname === "/vnc") {
      if (!this.cfg.vnc) return reject(404);
      const deviceId = this.tokens.consume(url.searchParams.get("token"), "vnc");
      if (!deviceId) return reject(401);
      this.vncWss.handleUpgrade(req, socket, head, (ws) => {
        this.track(ws, "vnc", deviceId);
        this.log.info(`vnc opened by ${deviceId}`);
        bridgeVnc(ws, this.cfg.vnc!, (m) => this.log.warn(m));
      });
      return;
    }
    reject(404);
  }

  private track(ws: WebSocket, kind: Conn["kind"], deviceId: string | null): Conn {
    const conn: Conn = { ws, kind, deviceId, lastSeen: Date.now(), subscribed: false, features: new Set() };
    this.conns.add(conn);
    ws.on("pong", () => (conn.lastSeen = Date.now()));
    ws.on("message", () => (conn.lastSeen = Date.now()));
    ws.on("close", () => this.conns.delete(conn));
    ws.on("error", () => ws.terminate());
    return conn;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private onControl(ws: WebSocket): void {
    const conn = this.track(ws, "control", null);
    const nonce = randomBytes(32).toString("base64url");
    this.send(ws, { type: "challenge", nonce, bootId: this.events.bootId, protocol: PROTOCOL_VERSION });

    // 10 秒内不完成鉴权就断开
    const authTimer = setTimeout(() => {
      if (!conn.deviceId) ws.close(CloseCode.AuthFailed, "auth timeout");
    }, 10_000);

    ws.on("close", () => clearTimeout(authTimer));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (!conn.deviceId) {
        if (msg.type !== "auth") return ws.close(CloseCode.AuthFailed, "auth required");
        const device = this.devices.verifySignature(msg.deviceId, authPayload(nonce, this.events.bootId), msg.signature);
        if (!device) {
          this.log.warn(`auth failed for device ${String(msg.deviceId).slice(0, 32)}`);
          this.send(ws, { type: "auth.fail", reason: "unknown device or bad signature" });
          return ws.close(CloseCode.AuthFailed, "auth failed");
        }
        clearTimeout(authTimer);
        conn.deviceId = device.id;
        this.log.info(`control connected: ${device.id} (${device.name})`);
        this.send(ws, {
          type: "auth.ok",
          deviceId: device.id,
          deviceName: device.name,
          bootId: this.events.bootId,
          claudeState: this.claude.state,
        });
        return;
      }

      switch (msg.type) {
        case "subscribe": {
          const { reset, events } = this.events.replay(msg.bootId, Number(msg.sinceSeq) || 0);
          if (reset) this.send(ws, { type: "replay.reset" });
          // 先补发，再标记为已订阅；Node 单线程，这两步之间不会插进新事件
          for (const ev of events) this.send(ws, { type: "event", event: ev });
          conn.subscribed = true;
          conn.features = new Set((Array.isArray(msg.features) ? msg.features : []).filter((f) => f === "chat" || f === "permissions"));
          if (conn.features.has("chat")) this.send(ws, { type: "chat.snapshot", ...this.transcript.snapshot() });
          return;
        }
        case "chat.send": {
          const id = String(msg.id ?? "");
          void this.chatSend(id, String(msg.text ?? "")).then((r) => this.send(ws, { type: "chat.ack", id, ...r }));
          return;
        }
        case "permission.decide": {
          const pending = this.pendingPermissions.get(String(msg.id));
          if (!pending || (msg.behavior !== "allow" && msg.behavior !== "deny")) return;
          this.log.info(`permission ${msg.id} ${msg.behavior} by ${conn.deviceId}`);
          pending.resolve({ behavior: msg.behavior, message: typeof msg.message === "string" ? msg.message.slice(0, 500) : undefined });
          return;
        }
        case "token.request": {
          if (msg.purpose !== "term" && msg.purpose !== "vnc") return;
          const t = this.tokens.issue(conn.deviceId, msg.purpose);
          this.send(ws, { type: "token", id: msg.id, purpose: msg.purpose, ...t });
          return;
        }
        case "ping":
          this.send(ws, { type: "pong", id: msg.id });
          return;
      }
    });
  }

  /**
   * 每 15 秒：
   * - 给所有连接发 WebSocket ping，45 秒没回应的判定为"假活着"，断开（NAT 超时、对端休眠时 TCP 不会立刻报错）。
   * - 检查设备列表是否变化，断开已被吊销设备的所有连接。
   */
  private heartbeat(): void {
    const now = Date.now();
    const v = this.devices.version();
    const devicesChanged = v !== this.devicesVersion;
    this.devicesVersion = v;
    const alive = devicesChanged ? new Set(this.devices.list().map((d) => d.id)) : null;

    for (const c of this.conns) {
      if (alive && c.deviceId && !alive.has(c.deviceId)) {
        this.log.info(`closing ${c.kind} connection of revoked device ${c.deviceId}`);
        c.ws.close(CloseCode.Revoked, "device revoked");
        continue;
      }
      if (now - c.lastSeen > this.opts.heartbeatTimeoutMs) {
        c.ws.terminate();
        continue;
      }
      if (c.ws.readyState === c.ws.OPEN) c.ws.ping();
    }
  }
}
