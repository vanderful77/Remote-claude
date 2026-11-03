import type { ClaudeState, EventBody, EventEnvelope } from "@rc/core";

/** 主进程与渲染进程之间的接口。渲染进程只能通过 preload 暴露的这些方法和主进程交流。 */

export interface Profile {
  url: string;
  deviceId: string;
  daemonName: string;
}

export interface Settings {
  /** 本地 Syncthing（可选）：用来显示"远程 -> 本地"方向的接收进度 */
  localSyncthing?: { url: string; apiKey: string };
  /** 本地同步文件夹路径，"打开同步文件夹"按钮用 */
  localFolder?: string;
}

export type ConnState = "disconnected" | "connecting" | "connected" | "reconnecting" | "fatal";

export interface ConnStatus {
  state: ConnState;
  detail?: string;
}

export interface GuiState {
  profile: Profile | null;
  conn: ConnStatus;
  claudeState: ClaudeState;
  events: EventEnvelope[];
  settings: Settings;
  /** 设备私钥的保护方式：系统钥匙串加密，或者明文文件（系统不支持加密时） */
  keyProtection: "os-keychain" | "plain-file";
}

export type PairResult = { ok: true } | { ok: false; error: string };

export interface RcApi {
  getState(): Promise<GuiState>;
  pair(url: string, code: string, name: string): Promise<PairResult>;
  unpair(): Promise<void>;
  termUrl(cols: number, rows: number): Promise<string>;
  vncUrl(): Promise<string>;
  saveSettings(s: Settings): Promise<void>;
  chooseLocalFolder(): Promise<string | null>;
  openLocalFolder(): Promise<string | null>;
  onEvent(cb: (ev: EventEnvelope) => void): () => void;
  onReset(cb: () => void): () => void;
  onConn(cb: (c: ConnStatus) => void): () => void;
  onClaudeState(cb: (s: ClaudeState) => void): () => void;
  /** 本地 Syncthing 的事件（远程 -> 本地 方向） */
  onLocalSync(cb: (ev: EventBody) => void): () => void;
}

export const IPC = {
  getState: "rc:getState",
  pair: "rc:pair",
  unpair: "rc:unpair",
  termUrl: "rc:termUrl",
  vncUrl: "rc:vncUrl",
  saveSettings: "rc:saveSettings",
  chooseLocalFolder: "rc:chooseLocalFolder",
  openLocalFolder: "rc:openLocalFolder",
  event: "rc:event",
  reset: "rc:reset",
  conn: "rc:conn",
  claudeState: "rc:claudeState",
  localSync: "rc:localSync",
} as const;
