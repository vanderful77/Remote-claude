import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type RcApi } from "./shared";

/**
 * preload：在沙箱化的界面里暴露一组最小的 API（window.rc）。
 * 界面只能调用这里列出的方法，碰不到 ipcRenderer 本身，更碰不到 Node。
 */

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: RcApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  pair: (url, code, name) => ipcRenderer.invoke(IPC.pair, url, code, name),
  unpair: () => ipcRenderer.invoke(IPC.unpair),
  termUrl: (cols, rows) => ipcRenderer.invoke(IPC.termUrl, cols, rows),
  vncUrl: () => ipcRenderer.invoke(IPC.vncUrl),
  saveSettings: (s) => ipcRenderer.invoke(IPC.saveSettings, s),
  chooseLocalFolder: () => ipcRenderer.invoke(IPC.chooseLocalFolder),
  openLocalFolder: () => ipcRenderer.invoke(IPC.openLocalFolder),
  onEvent: (cb) => on(IPC.event, cb),
  onReset: (cb) => on(IPC.reset, () => cb()),
  onConn: (cb) => on(IPC.conn, cb),
  onClaudeState: (cb) => on(IPC.claudeState, cb),
  onLocalSync: (cb) => on(IPC.localSync, cb),
};

contextBridge.exposeInMainWorld("rc", api);
