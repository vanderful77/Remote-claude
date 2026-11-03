import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import type { Profile, Settings } from "./shared";

/**
 * GUI 的本地存储（Electron 的 userData 目录）。
 *
 * 设备私钥用 Electron 的 safeStorage 加密后再写盘，密钥由操作系统保管：
 * macOS 是 Keychain，Windows 是 DPAPI，Linux 是 Secret Service（GNOME Keyring / KWallet）。
 * 这样即使有人拷走了这个文件，没有你的系统登录也解不开。
 *
 * 例外：Linux 上没有钥匙串服务时，safeStorage 会退化成"basic_text"（几乎等于明文），
 * 这种情况下我们如实标记为 plain-file，界面上会提示。
 */

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function keychainUsable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === "linux") {
    const backend = (safeStorage as any).getSelectedStorageBackend?.();
    if (backend === "basic_text" || backend === "unknown") return false;
  }
  return true;
}

interface IdentityFile {
  publicKey: string;
  privateKeyEnc?: string;
  privateKeyPem?: string;
}

export class Store {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private p(name: string) {
    return join(this.dir, name);
  }

  identity(): { publicKey: string; privateKey: KeyObject; protection: "os-keychain" | "plain-file" } {
    const f = readJson<IdentityFile>(this.p("identity.json"));
    if (f?.privateKeyEnc) {
      const pem = safeStorage.decryptString(Buffer.from(f.privateKeyEnc, "base64"));
      return { publicKey: f.publicKey, privateKey: createPrivateKey(pem), protection: "os-keychain" };
    }
    if (f?.privateKeyPem) {
      return { publicKey: f.publicKey, privateKey: createPrivateKey(f.privateKeyPem), protection: "plain-file" };
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const x = publicKey.export({ format: "jwk" }).x!;
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const out: IdentityFile = { publicKey: x };
    const protection = keychainUsable() ? "os-keychain" : "plain-file";
    if (protection === "os-keychain") out.privateKeyEnc = safeStorage.encryptString(pem).toString("base64");
    else out.privateKeyPem = pem;
    writeAtomic(this.p("identity.json"), JSON.stringify(out, null, 2));
    return { publicKey: x, privateKey, protection };
  }

  profile(): Profile | null {
    return readJson<Profile>(this.p("profile.json"));
  }

  saveProfile(p: Profile) {
    writeAtomic(this.p("profile.json"), JSON.stringify(p, null, 2));
  }

  /** 解除配对：删除 profile 和私钥。下次配对会生成一把新钥匙 */
  forget() {
    rmSync(this.p("profile.json"), { force: true });
    rmSync(this.p("identity.json"), { force: true });
  }

  settings(): Settings {
    return readJson<Settings>(this.p("settings.json")) ?? {};
  }

  saveSettings(s: Settings) {
    writeAtomic(this.p("settings.json"), JSON.stringify(s, null, 2));
  }
}
