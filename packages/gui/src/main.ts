import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pair, RemoteClient, toWsUrl } from "@rc/client";
import { SyncthingWatcher, deviceIdFromKey, type ClaudeState, type EventEnvelope } from "@rc/core";
import { IPC, type ConnStatus, type GuiState, type PairResult, type Settings } from "./shared";
import { Store } from "./store";

/**
 * 主进程：持有到 daemon 的控制连接（RemoteClient）和设备私钥。
 *
 * 渲染进程（界面）运行在沙箱里，拿不到私钥，也不能直接调用 Node。
 * 它需要打开终端或画面时，向主进程要一个"带一次性令牌的 WebSocket 地址"，然后自己连过去。
 * 这样私钥只存在于主进程，界面里即使出现 XSS，也偷不到长期凭据。
 */

if (process.env.RC_GUI_HOME) app.setPath("userData", process.env.RC_GUI_HOME);

const MAX_EVENTS = 2000;
const store = new Store(app.getPath("userData"));

let win: BrowserWindow | null = null;
let client: RemoteClient | null = null;
let localWatcher: SyncthingWatcher | null = null;
let events: EventEnvelope[] = [];
let conn: ConnStatus = { state: "disconnected" };
let claudeState: ClaudeState = "unknown";
let keyProtection: GuiState["keyProtection"] = "plain-file";

const RENDERER_URL = pathToFileURL(join(__dirname, "index.html")).toString();

function send(channel: string, payload?: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

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
  client = new RemoteClient({ url: profile.url, deviceId: profile.deviceId, privateKey: id.privateKey });
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
  });
  setConn({ state: "connecting" });
  client.start();
}

function startLocalSync(settings: Settings) {
  void localWatcher?.stop();
  localWatcher = null;
  const st = settings.localSyncthing;
  if (!st?.url || !st.apiKey) return;
  localWatcher = new SyncthingWatcher({ url: st.url, apiKey: st.apiKey });
  localWatcher.on("event", (e) => send(IPC.localSync, e));
  localWatcher.start();
}

/** 只接受来自我们自己页面的 IPC 调用 */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) {
  ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (e.senderFrame?.url !== RENDERER_URL) throw new Error("unexpected IPC sender");
    return fn(...(args as A));
  });
}

function registerIpc() {
  handle(IPC.getState, (): GuiState => ({
    profile: store.profile(),
    conn,
    claudeState,
    events,
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

  handle(IPC.saveSettings, (s: Settings) => {
    const clean: Settings = {};
    if (s?.localSyncthing?.url && s.localSyncthing.apiKey)
      clean.localSyncthing = { url: String(s.localSyncthing.url), apiKey: String(s.localSyncthing.apiKey) };
    if (s?.localFolder) clean.localFolder = String(s.localFolder);
    store.saveSettings(clean);
    startLocalSync(clean);
  });

  handle(IPC.chooseLocalFolder, async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "选择本地同步文件夹" });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  handle(IPC.openLocalFolder, async () => {
    const folder = store.settings().localFolder;
    if (!folder) return "还没有设置本地同步文件夹（在设置里选择）";
    const err = await shell.openPath(folder);
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

  // 界面里不允许跳转到别的页面、不允许开新窗口（链接一律交给系统浏览器）
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
  startLocalSync(store.settings());
});

app.on("window-all-closed", () => {
  client?.stop();
  void localWatcher?.stop();
  app.quit();
});
