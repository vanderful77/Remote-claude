import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { resolve as resolvePath, join } from "node:path";
import { pathToFileURL } from "node:url";
import { pair, RemoteClient, toWsUrl } from "@rc/client";
import { SyncthingWatcher, deviceIdFromKey, type ClaudeState, type EventEnvelope } from "@rc/core";
import { LocalFolder } from "./files";
import { IPC, type ChatState, type ConnStatus, type GuiState, type PairResult, type Settings } from "./shared";
import { Store } from "./store";

/**
 * 主进程：持有到 daemon 的控制连接（RemoteClient）和设备私钥，管理本地同步文件夹。
 *
 * 渲染进程（界面）运行在沙箱里，拿不到私钥，也不能直接调用 Node。
 * 它需要打开终端或画面时，向主进程要一个"带一次性令牌的 WebSocket 地址"，然后自己连过去。
 * 这样私钥只存在于主进程，界面里即使出现 XSS，也偷不到长期凭据。
 */

if (process.env.RC_GUI_HOME) app.setPath("userData", process.env.RC_GUI_HOME);

const MAX_EVENTS = 2000;
const MAX_CHAT_ITEMS = 1500;
const store = new Store(app.getPath("userData"));

let win: BrowserWindow | null = null;
let client: RemoteClient | null = null;
let localWatcher: SyncthingWatcher | null = null;
let localFolderId: string | null = null;
let events: EventEnvelope[] = [];
let chat: ChatState = { sessionId: null, items: [] };
let conn: ConnStatus = { state: "disconnected" };
let claudeState: ClaudeState = "unknown";
let keyProtection: GuiState["keyProtection"] = "plain-file";

const RENDERER_URL = pathToFileURL(join(__dirname, "index.html")).toString();

function send(channel: string, payload?: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const folder = new LocalFolder(
  () => store.settings().localFolder,
  (list) => send(IPC.attachments, list),
  async (rel) => {
    const st = store.settings().localSyncthing;
    if (!st || !localFolderId) return;
    const u = new URL(`/rest/db/scan?folder=${encodeURIComponent(localFolderId)}&sub=${encodeURIComponent(rel)}`, st.url);
    await fetch(u, { method: "POST", headers: { "X-API-Key": st.apiKey } });
  },
);

function setConn(c: ConnStatus) {
  conn = c;
  send(IPC.conn, c);
}

function setClaudeState(s: ClaudeState) {
  const prev = claudeState;
  claudeState = s;
  send(IPC.claudeState, s);
  // Claude 停下来等你确认时，如果窗口不在前台，发一条系统通知
  if (s === "awaiting_input" && prev !== s && win && !win.isFocused() && Notification.isSupported()) {
    new Notification({ title: "Claude 在等你", body: "远程 Claude 需要你确认或输入" }).show();
  }
}

function connect() {
  client?.stop();
  client = null;
  const profile = store.profile();
  if (!profile) {
    setConn({ state: "disconnected" });
    return;
  }
  const id = store.identity();
  keyProtection = id.protection;
  client = new RemoteClient({
    url: profile.url,
    deviceId: profile.deviceId,
    privateKey: id.privateKey,
    features: ["chat", "permissions"],
  });
  client.on("connected", (info) => {
    setConn({ state: "connected" });
    setClaudeState(info.claudeState);
  });
  client.on("disconnected", (d) => {
    if (d.retryInMs === null) return;
    setConn({ state: "reconnecting", detail: `${Math.max(1, Math.round(d.retryInMs / 1000))} 秒后重连` });
  });
  client.on("fatal", (msg) => setConn({ state: "fatal", detail: msg }));
  client.on("reset", () => {
    events = [];
    send(IPC.reset);
  });
  client.on("event", (ev) => {
    events.push(ev);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    send(IPC.event, ev);
    if (ev.body.t === "claude.state") setClaudeState(ev.body.state);
    folder.onRemoteEvent(ev.body);
  });
  client.on("chatSnapshot", (s) => {
    chat = { sessionId: s.sessionId, items: s.items };
    send(IPC.chatSnapshot, chat);
  });
  client.on("chatAppend", (a) => {
    if (a.sessionId !== chat.sessionId) chat = { sessionId: a.sessionId, items: [] };
    chat.items.push(...a.items);
    if (chat.items.length > MAX_CHAT_ITEMS) chat.items.splice(0, chat.items.length - MAX_CHAT_ITEMS);
    send(IPC.chatAppend, a);
  });
  setConn({ state: "connecting" });
  client.start();
}

/** 本地 Syncthing：显示"远程 -> 本地"的进度；找到同步文件夹的 id，用来触发即时扫描 */
async function startLocalSync(settings: Settings) {
  void localWatcher?.stop();
  localWatcher = null;
  localFolderId = null;
  const st = settings.localSyncthing;
  if (!st?.url || !st.apiKey) return;
  localWatcher = new SyncthingWatcher({ url: st.url, apiKey: st.apiKey });
  localWatcher.on("event", (e) => send(IPC.localSync, e));
  localWatcher.start();
  if (settings.localFolder) {
    try {
      const res = await fetch(new URL("/rest/config/folders", st.url), { headers: { "X-API-Key": st.apiKey } });
      const folders: { id: string; path: string }[] = await res.json();
      const want = resolvePath(settings.localFolder);
      localFolderId = folders.find((f) => resolvePath(f.path) === want)?.id ?? null;
    } catch {
      /* 拿不到也没关系，只是少了即时扫描 */
    }
  }
}

/** 只接受来自我们自己页面的 IPC 调用 */
function trusted(e: IpcMainInvokeEvent | IpcMainEvent) {
  return e.senderFrame?.url === RENDERER_URL;
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) {
  ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!trusted(e)) throw new Error("unexpected IPC sender");
    return fn(...(args as A));
  });
}

async function errorOf(fn: () => Promise<void>): Promise<{ error?: string }> {
  try {
    await fn();
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 拖出文件时显示的小图标（macOS 要求必须有图标）：32x32 的简单文档形状 */
function dragIcon() {
  const w = 32;
  const buf = Buffer.alloc(w * w * 4);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const inside = x >= 6 && x < 26 && y >= 3 && y < 29;
      const fold = x >= 20 && y < 9 && x - 20 > y - 3;
      const i = (y * w + x) * 4;
      if (inside && !fold) {
        const line = y > 12 && y < 25 && y % 4 === 0 && x > 9 && x < 23;
        buf[i] = line ? 0x90 : 0xf0; // B
        buf[i + 1] = line ? 0x90 : 0xf0; // G
        buf[i + 2] = line ? 0x90 : 0xf0; // R
        buf[i + 3] = 0xff;
      }
    }
  return nativeImage.createFromBitmap(buf, { width: w, height: w });
}

function registerIpc() {
  handle(IPC.getState, (): GuiState => ({
    profile: store.profile(),
    conn,
    claudeState,
    events,
    chat,
    attachments: folder.list(),
    settings: store.settings(),
    keyProtection,
  }));

  handle(IPC.pair, async (url: string, code: string, name: string): Promise<PairResult> => {
    try {
      const u = new URL(String(url).trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("地址必须以 http:// 或 https:// 开头");
      const id = store.identity();
      keyProtection = id.protection;
      const r = await pair(u.origin, String(code), String(name || "desktop"), id.publicKey);
      if (r.deviceId !== deviceIdFromKey(id.publicKey)) throw new Error("daemon 返回的设备 id 不一致");
      store.saveProfile({ url: u.origin, deviceId: r.deviceId, daemonName: r.daemonName });
      events = [];
      chat = { sessionId: null, items: [] };
      connect();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  handle(IPC.unpair, () => {
    client?.stop();
    client = null;
    store.forget();
    events = [];
    chat = { sessionId: null, items: [] };
    setConn({ state: "disconnected" });
  });

  handle(IPC.termUrl, async (cols: number, rows: number) => {
    if (!client?.connected) throw new Error("未连接");
    const token = await client.requestToken("term");
    return toWsUrl(client.url, "/term", { token, cols: Math.floor(cols), rows: Math.floor(rows) });
  });

  handle(IPC.vncUrl, async () => {
    if (!client?.connected) throw new Error("未连接");
    return client.vncUrl();
  });

  handle(IPC.sendChat, async (text: string) => {
    if (!client?.connected) return { status: "rejected", reason: "未连接" };
    const r = await client.sendChat(String(text));
    if (r.status !== "rejected") folder.clearReady();
    return r;
  });

  handle(IPC.decidePermission, (id: string, behavior: "allow" | "deny") => {
    if (behavior !== "allow" && behavior !== "deny") return;
    client?.decidePermission(String(id), behavior);
  });

  handle(IPC.attachPaths, (paths: string[]) =>
    errorOf(() => folder.attachPaths((Array.isArray(paths) ? paths : []).map(String).filter(Boolean))),
  );
  handle(IPC.attachData, (name: string, data: Uint8Array) => errorOf(() => folder.attachData(String(name), data)));
  handle(IPC.removeAttachment, (id: string) => folder.remove(String(id)));

  handle(IPC.listFiles, () => folder.listFiles());
  handle(IPC.openFile, async (rel: string) => {
    try {
      return (await shell.openPath(await folder.resolveRel(rel))) || null;
    } catch (e) {
      return (e as Error).message;
    }
  });
  handle(IPC.revealFile, async (rel: string) => shell.showItemInFolder(await folder.resolveRel(rel)));

  // 拖出必须在 dragstart 期间发起，所以用 send（同步触发），不用 invoke
  const icon = dragIcon();
  ipcMain.on(IPC.startDrag, (e: IpcMainEvent, rel: string) => {
    if (!trusted(e)) return;
    folder
      .resolveRel(String(rel))
      .then((file) => e.sender.startDrag({ file, icon }))
      .catch(() => {});
  });

  handle(IPC.saveSettings, (s: Settings) => {
    const clean: Settings = {};
    if (s?.localSyncthing?.url && s.localSyncthing.apiKey)
      clean.localSyncthing = { url: String(s.localSyncthing.url), apiKey: String(s.localSyncthing.apiKey) };
    if (s?.localFolder) clean.localFolder = String(s.localFolder);
    store.saveSettings(clean);
    void startLocalSync(clean);
  });

  handle(IPC.chooseLocalFolder, async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "选择本地同步文件夹" });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  handle(IPC.openLocalFolder, async () => {
    const f = store.settings().localFolder;
    if (!f) return "还没有设置本地同步文件夹（在设置里选择）";
    const err = await shell.openPath(f);
    return err || null;
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Remote Claude",
    backgroundColor: "#15171c",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // 界面里不允许跳转到别的页面（包括把文件拖进窗口时浏览器默认的"打开文件"）、不允许开新窗口
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== RENDERER_URL) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadURL(RENDERER_URL);
  win.on("closed", () => (win = null));
}

app.whenReady().then(() => {
  // 界面不需要摄像头、麦克风、定位等任何权限
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerIpc();
  createWindow();
  connect();
  void startLocalSync(store.settings());
});

app.on("window-all-closed", () => {
  client?.stop();
  void localWatcher?.stop();
  app.quit();
});

