/**
 * 两端共用的协议定义。
 *
 * 三条通道：
 *   /ws    控制与事件：JSON 文本帧，先挑战应答鉴权，再订阅事件（带序号，可补发）
 *   /term  终端：每个连接对应远程一个 `tmux attach`。二进制帧是终端字节，文本帧是 JSON 控制（resize）
 *   /vnc   画面：WebSocket <-> RFB(TCP) 透明桥，noVNC 直接连
 * /term 和 /vnc 用一次性短期令牌鉴权，令牌通过已鉴权的 /ws 申请。
 */

import { createHash } from "node:crypto";

export const PROTOCOL_VERSION = 1;

/** 设备 id = 公钥（JWK x）的 sha256 前 16 位十六进制。两端用同一个算法，客户端可以核对 daemon 的回复。 */
export function deviceIdFromKey(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

/** 签名内容的固定前缀，防止这把设备私钥签出的东西被挪作他用（域分离）。 */
export const AUTH_CONTEXT = "remote-claude/auth/v1";

export function authPayload(nonce: string, bootId: string): Buffer {
  return Buffer.from(`${AUTH_CONTEXT}\n${nonce}\n${bootId}`, "utf8");
}

export type ClaudeState = "unknown" | "idle" | "busy" | "awaiting_input" | "stopped";

export type EventBody =
  | { t: "daemon.started"; version: string }
  | {
      t: "claude.hook";
      hook: string;
      sessionId?: string;
      tool?: string;
      /** 给时间线显示的一行摘要，例如文件路径或命令 */
      summary?: string;
      /** 经过裁剪的 hook 原始数据（去掉大字段） */
      payload: unknown;
    }
  | { t: "claude.state"; state: ClaudeState; reason: string }
  | {
      t: "sync.item";
      folder: string;
      path: string;
      action: string;
      phase: "started" | "finished";
      error?: string;
    }
  | { t: "sync.progress"; folder: string; path: string; bytesDone: number; bytesTotal: number }
  | { t: "sync.folder"; folder: string; state: string }
  | { t: "sync.connection"; status: "up" | "down"; error?: string }
  /**
   * Syncthing 把一个文件完整、校验通过地落盘之后发出。
   * absPath：该文件在 daemon 那台机器上的绝对路径（能查到 Syncthing 文件夹配置时才有），
   * GUI 用它在输入框里插入 @引用。
   */
  | { t: "file.ready"; folder: string; path: string; absPath?: string }
  /** Claude 请求权限，等待 GUI 回答（PermissionRequest hook） */
  | { t: "permission.request"; id: string; tool: string; summary?: string; input: unknown }
  /** 权限请求结束：gui=有人在 GUI 里回答了；timeout=没人回答，退回终端里的确认框 */
  | { t: "permission.resolved"; id: string; behavior?: "allow" | "deny"; by: "gui" | "timeout" }
  /** 通过对话输入框发给 Claude 的消息的去向 */
  | { t: "chat.input"; id: string; status: "sent" | "queued" | "dropped"; preview: string; reason?: string };

/**
 * 对话视图里的一项，由 daemon 从 Claude Code 的会话记录（.jsonl）解析而来。
 * 会话记录是 Claude Code 的内部格式，官方不保证稳定，所以解析只取最基本的字段，认不出的一律跳过。
 */
export type ChatItem =
  | { k: "user"; id: string; ts: number; text: string }
  /** 中断提示、斜杠命令回显等，显示成小号的系统提示 */
  | { k: "note"; id: string; ts: number; text: string }
  | { k: "assistant"; id: string; ts: number; text: string }
  | { k: "tool_use"; id: string; ts: number; toolId: string; name: string; summary?: string; input: unknown }
  | { k: "tool_result"; id: string; ts: number; toolId: string; isError: boolean; text: string };

export interface EventEnvelope {
  seq: number;
  ts: number;
  body: EventBody;
}

export type TokenPurpose = "term" | "vnc";

/** 客户端 -> 服务端（/ws） */
export type ClientMessage =
  | { type: "auth"; deviceId: string; signature: string }
  /**
   * features：客户端声明自己能处理的能力。
   *   "permissions"：能在界面上回答权限请求。没有这类客户端在线时，daemon 不拦截权限请求。
   *   "chat"：需要对话视图数据（会话记录快照与增量）。
   */
  | { type: "subscribe"; bootId: string | null; sinceSeq: number; features?: ClientFeature[] }
  | { type: "token.request"; id: number; purpose: TokenPurpose }
  | { type: "chat.send"; id: string; text: string }
  | { type: "permission.decide"; id: string; behavior: "allow" | "deny"; message?: string }
  | { type: "ping"; id: number };

/** 服务端 -> 客户端（/ws） */
export type ServerMessage =
  | { type: "challenge"; nonce: string; bootId: string; protocol: number }
  | { type: "auth.ok"; deviceId: string; deviceName: string; bootId: string; claudeState: ClaudeState }
  | { type: "auth.fail"; reason: string }
  /** 客户端记住的序号已经不可用（daemon 重启过，或断线太久被挤出缓冲），从头开始 */
  | { type: "replay.reset" }
  | { type: "event"; event: EventEnvelope }
  | { type: "token"; id: number; purpose: TokenPurpose; token: string; expiresAt: number }
  | { type: "pong"; id: number }
  | { type: "error"; message: string }
  /** 当前会话的完整对话（订阅时、以及 Claude 换了新会话时发送） */
  | { type: "chat.snapshot"; sessionId: string | null; items: ChatItem[] }
  | { type: "chat.append"; sessionId: string; items: ChatItem[] }
  | { type: "chat.ack"; id: string; status: "sent" | "queued" | "rejected"; reason?: string };

export type ClientFeature = "permissions" | "chat";

/** /term 上客户端发的文本帧 */
export type TermControl = { type: "resize"; cols: number; rows: number };

/** POST /pair 的请求和响应 */
export interface PairRequest {
  code: string;
  name: string;
  /** Ed25519 公钥的 JWK x 字段（base64url，32 字节） */
  publicKey: string;
}
export interface PairResponse {
  deviceId: string;
  daemonName: string;
}

/** WebSocket 关闭码（4000-4999 是应用自定义区间） */
export const CloseCode = {
  AuthFailed: 4001,
  Revoked: 4003,
  HeartbeatTimeout: 4008,
  Shutdown: 4010,
} as const;

/** 心跳参数：两端共用，保证判断一致 */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;
