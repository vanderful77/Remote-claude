import type { ChatItem, ClaudeState, EventBody, EventEnvelope } from "@rc/core";

/** 主进程与渲染进程之间的接口。渲染进程只能通过 preload 暴露的这些方法和主进程交流。 */

export interface Profile {
  url: string;
  deviceId: string;
  daemonName: string;
}

export interface Settings {
  /** 本地 Syncthing（可选）：显示"远程 -> 本地"的接收进度，并在拖入文件后立刻触发扫描 */
  localSyncthing?: { url: string; apiKey: string };
  /** 本地同步文件夹（和远程工作目录同步的那个文件夹） */
  localFolder?: string;
}

export type ConnState = "disconnected" | "connecting" | "connected" | "reconnecting" | "fatal";

export interface ConnStatus {
  state: ConnState;
  detail?: string;
}

/**
 * 拖进来的文件。流程：复制到本地同步文件夹的 inbox/（copying）
 * -> Syncthing 传到远程（syncing，带进度）-> 远程完整落盘（ready，此时才能让 Claude 引用它）。
 */
export interface Attachment {
  id: string;
  name: string;
  /** 相对同步文件夹根目录的路径，正斜杠，例如 inbox/报告.xlsx */
  rel: string;
  size: number;
  state: "copying" | "syncing" | "ready" | "failed";
  /** 0..1 */
  progress: number;
  /** 远程绝对路径（远程 Syncthing 告诉我们的）；没有时用 rel */
  remotePath?: string;
  error?: string;
}

export interface FileEntry {
  rel: string;
  name: string;
  /** 所在的顶层目录，例如 outbox、inbox */
  dir: string;
  size: number;
  mtime: number;
}

export interface ChatState {
  sessionId: string | null;
  items: ChatItem[];
}

export interface GuiState {
  profile: Profile | null;
  conn: ConnStatus;
  claudeState: ClaudeState;
  events: EventEnvelope[];
  chat: ChatState;
  attachments: Attachment[];
  settings: Settings;
  /** 设备私钥的保护方式：系统钥匙串加密，或者明文文件（系统不支持加密时） */
  keyProtection: "os-keychain" | "plain-file";
}

export type PairResult = { ok: true } | { ok: false; error: string };
export type ChatAck = { id?: string; status: "sent" | "queued" | "rejected"; reason?: string };

export interface RcApi {
  getState(): Promise<GuiState>;
  pair(url: string, code: string, name: string): Promise<PairResult>;
  unpair(): Promise<void>;
  termUrl(cols: number, rows: number): Promise<string>;
  vncUrl(): Promise<string>;
  saveSettings(s: Settings): Promise<void>;
  chooseLocalFolder(): Promise<string | null>;
  openLocalFolder(): Promise<string | null>;

  sendChat(text: string): Promise<ChatAck>;
  decidePermission(id: string, behavior: "allow" | "deny"): Promise<void>;

  /** 拖入或选择的本地文件（真实路径） */
  attachPaths(paths: string[]): Promise<{ error?: string }>;
  /** 粘贴的截图等没有路径的数据 */
  attachData(name: string, data: Uint8Array): Promise<{ error?: string }>;
  removeAttachment(id: string): Promise<void>;
  /** 取 File 对象在本机的真实路径（拖拽、文件选择框）；取不到返回空字符串 */
  pathForFile(file: File): string;

  listFiles(): Promise<{ folder: string | null; files: FileEntry[] }>;
  openFile(rel: string): Promise<string | null>;
  revealFile(rel: string): Promise<void>;
  /** 从界面把文件拖到桌面、邮件等（必须在 dragstart 里同步调用） */
  startDrag(rel: string): void;

  onEvent(cb: (ev: EventEnvelope) => void): () => void;
  onReset(cb: () => void): () => void;
  onConn(cb: (c: ConnStatus) => void): () => void;
  onClaudeState(cb: (s: ClaudeState) => void): () => void;
  /** 本地 Syncthing 的事件（远程 -> 本地 方向） */
  onLocalSync(cb: (ev: EventBody) => void): () => void;
  onChatSnapshot(cb: (c: ChatState) => void): () => void;
  onChatAppend(cb: (c: { sessionId: string; items: ChatItem[] }) => void): () => void;
  onAttachments(cb: (list: Attachment[]) => void): () => void;
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
  sendChat: "rc:sendChat",
  decidePermission: "rc:decidePermission",
  attachPaths: "rc:attachPaths",
  attachData: "rc:attachData",
  removeAttachment: "rc:removeAttachment",
  listFiles: "rc:listFiles",
  openFile: "rc:openFile",
  revealFile: "rc:revealFile",
  startDrag: "rc:startDrag",
  event: "rc:event",
  reset: "rc:reset",
  conn: "rc:conn",
  claudeState: "rc:claudeState",
  localSync: "rc:localSync",
  chatSnapshot: "rc:chatSnapshot",
  chatAppend: "rc:chatAppend",
  attachments: "rc:attachments",
} as const;
