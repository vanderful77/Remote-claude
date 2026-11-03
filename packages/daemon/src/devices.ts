import { createHash, createPublicKey, randomInt, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceIdFromKey } from "@rc/core";

/**
 * 设备与配对。
 *
 * 配对流程：
 *   1. 在远程执行 `rcd pair`，生成一次性配对码（10 分钟有效，最多试 5 次），只把哈希写进 pairing.json。
 *   2. 本地 `rc pair <url> <code>` 生成 Ed25519 密钥对，把配对码和公钥 POST 到 /pair。
 *   3. daemon 核对配对码，把公钥记进 devices.json，配对码作废。
 * 之后每次连接都是挑战应答：daemon 发随机数，客户端用私钥签名。私钥从不离开本地。
 *
 * 文件就是数据库：daemon 每次鉴权都重新读 devices.json（很小），
 * 所以 `rcd revoke` 直接改文件即可生效，不需要和运行中的 daemon 通信。
 */

export interface Device {
  id: string;
  name: string;
  /** Ed25519 公钥 JWK 的 x（base64url） */
  publicKey: string;
  createdAt: string;
}

interface PairingFile {
  codeHash: string;
  expiresAt: number;
  attemptsLeft: number;
}

/** 去掉容易看错的 0/O、1/I/L */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_ATTEMPTS = 5;

export function publicKeyObject(x: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashCode(code: string): Buffer {
  return createHash("sha256").update(normalizeCode(code)).digest();
}

/** 先写临时文件再改名：进程中途崩溃也不会留下写了一半的 JSON */
function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export class DeviceStore {
  private readonly devicesPath: string;
  private readonly pairingPath: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.devicesPath = join(stateDir, "devices.json");
    this.pairingPath = join(stateDir, "pairing.json");
  }

  list(): Device[] {
    try {
      return JSON.parse(readFileSync(this.devicesPath, "utf8")).devices ?? [];
    } catch {
      return [];
    }
  }

  get(id: string): Device | undefined {
    return this.list().find((d) => d.id === id);
  }

  /** 用于快速判断设备列表是否变化（吊销检测） */
  version(): number {
    try {
      return statSync(this.devicesPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  revoke(id: string): boolean {
    const devices = this.list();
    const next = devices.filter((d) => d.id !== id);
    if (next.length === devices.length) return false;
    writeJsonAtomic(this.devicesPath, { devices: next });
    return true;
  }

  /** 生成新配对码，返回给人看的形式 XXXX-XXXX */
  createPairingCode(now = Date.now()): string {
    let code = "";
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const file: PairingFile = {
      codeHash: hashCode(code).toString("hex"),
      expiresAt: now + PAIRING_TTL_MS,
      attemptsLeft: PAIRING_ATTEMPTS,
    };
    writeJsonAtomic(this.pairingPath, file);
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  /**
   * 用配对码登记一台新设备。失败抛出 Error（消息可以直接返回给客户端，不泄露细节）。
   */
  pair(code: string, name: string, publicKey: string, now = Date.now()): Device {
    let pairing: PairingFile;
    try {
      pairing = JSON.parse(readFileSync(this.pairingPath, "utf8"));
    } catch {
      throw new Error("no active pairing code");
    }
    if (now > pairing.expiresAt || pairing.attemptsLeft <= 0) {
      rmSync(this.pairingPath, { force: true });
      throw new Error("pairing code expired");
    }
    const ok = timingSafeEqual(hashCode(code), Buffer.from(pairing.codeHash, "hex"));
    if (!ok) {
      pairing.attemptsLeft -= 1;
      if (pairing.attemptsLeft <= 0) rmSync(this.pairingPath, { force: true });
      else writeJsonAtomic(this.pairingPath, pairing);
      throw new Error("invalid pairing code");
    }
    // 校验公钥格式（非法会抛错）
    publicKeyObject(publicKey);
    rmSync(this.pairingPath, { force: true });

    const device: Device = {
      id: deviceIdFromKey(publicKey),
      name: name.slice(0, 64) || "unnamed",
      publicKey,
      createdAt: new Date(now).toISOString(),
    };
    const devices = this.list().filter((d) => d.id !== device.id);
    devices.push(device);
    writeJsonAtomic(this.devicesPath, { devices });
    return device;
  }

  verifySignature(deviceId: string, payload: Buffer, signatureB64: string): Device | null {
    const device = this.get(deviceId);
    if (!device) return null;
    try {
      const ok = verify(null, payload, publicKeyObject(device.publicKey), Buffer.from(signatureB64, "base64"));
      return ok ? device : null;
    } catch {
      return null;
    }
  }
}
