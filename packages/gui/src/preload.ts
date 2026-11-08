import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
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
  sendChat: (text) => ipcRenderer.invoke(IPC.sendChat, text),
  decidePermission: (id, behavior) => ipcRenderer.invoke(IPC.decidePermission, id, behavior),
  attachPaths: (paths) => ipcRenderer.invoke(IPC.attachPaths, paths),
  attachData: (name, data) => ipcRenderer.invoke(IPC.attachData, name, data),
  removeAttachment: (id) => ipcRenderer.invoke(IPC.removeAttachment, id),
  // 沙箱里的 File 对象没有 path 属性，必须通过 webUtils 取真实路径
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  listFiles: () => ipcRenderer.invoke(IPC.listFiles),
  openFile: (rel) => ipcRenderer.invoke(IPC.openFile, rel),
  revealFile: (rel) => ipcRenderer.invoke(IPC.revealFile, rel),
  startDrag: (rel) => ipcRenderer.send(IPC.startDrag, rel),
  onEvent: (cb) => on(IPC.event, cb),
  onReset: (cb) => on(IPC.reset, () => cb()),
  onConn: (cb) => on(IPC.conn, cb),
  onClaudeState: (cb) => on(IPC.claudeState, cb),
  onLocalSync: (cb) => on(IPC.localSync, cb),
  onChatSnapshot: (cb) => on(IPC.chatSnapshot, cb),
  onChatAppend: (cb) => on(IPC.chatAppend, cb),
  onAttachments: (cb) => on(IPC.attachments, cb),
};

contextBridge.exposeInMainWorld("rc", api);
