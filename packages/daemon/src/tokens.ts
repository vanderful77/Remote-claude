import { randomBytes } from "node:crypto";
import type { TokenPurpose } from "@rc/core";

/**
 * /term 和 /vnc 的一次性令牌。
 *
 * 为什么不直接在这两条连接上再做一次挑战应答：noVNC 是现成的浏览器端库，
 * 它只会"打开一个 WebSocket 然后说 VNC 协议"，插不进我们的握手。
 * 所以由已鉴权的 /ws 发一个 60 秒内有效、只能用一次的令牌，放在 URL 里。
 */
export const TOKEN_TTL_MS = 60_000;

interface Entry {
  deviceId: string;
  purpose: TokenPurpose;
  expiresAt: number;
}

export class TokenStore {
  private tokens = new Map<string, Entry>();

  issue(deviceId: string, purpose: TokenPurpose, now = Date.now()): { token: string; expiresAt: number } {
    this.gc(now);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = now + TOKEN_TTL_MS;
    this.tokens.set(token, { deviceId, purpose, expiresAt });
    return { token, expiresAt };
  }

  /** 校验并作废。返回设备 id，失败返回 null */
  consume(token: string | null, purpose: TokenPurpose, now = Date.now()): string | null {
    if (!token) return null;
    const e = this.tokens.get(token);
    if (!e) return null;
    this.tokens.delete(token);
    if (e.purpose !== purpose || now > e.expiresAt) return null;
    return e.deviceId;
  }

  private gc(now: number) {
    for (const [k, e] of this.tokens) if (now > e.expiresAt) this.tokens.delete(k);
  }
}
