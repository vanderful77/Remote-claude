import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * 本地设备身份：一把 Ed25519 私钥 + 已配对的 daemon 资料。
 *
 * 目前私钥以 0600 权限存成文件。GUI 阶段会改成存进系统钥匙串
 * （macOS Keychain / Windows Credential Manager / Linux Secret Service），
 * 这里先保证接口不变：调用方只拿 KeyObject，不关心它从哪来。
 */

export function configDir(): string {
  if (process.env.RC_HOME) return process.env.RC_HOME;
  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "remote-claude");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "remote-claude");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "remote-claude");
  }
}

export interface Identity {
  /** JWK x（base64url），配对时发给 daemon */
  publicKey: string;
  privateKey: KeyObject;
}

export interface Profile {
  url: string;
  deviceId: string;
  daemonName: string;
}

function writePrivate(path: string, text: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadOrCreateIdentity(dir = configDir()): Identity {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "identity.json");
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return { publicKey: j.publicKey, privateKey: createPrivateKey(j.privateKeyPem) };
  } catch {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const x = publicKey.export({ format: "jwk" }).x!;
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    writePrivate(path, JSON.stringify({ publicKey: x, privateKeyPem: pem }, null, 2));
    return { publicKey: x, privateKey };
  }
}

export function loadProfile(dir = configDir()): Profile | null {
  try {
    return JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  } catch {
    return null;
  }
}

export function saveProfile(p: Profile, dir = configDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(join(dir, "profile.json"), JSON.stringify(p, null, 2));
}
