import type { ClaudeState } from "@rc/core";
import { claudeStateText } from "@rc/client/format";
import type { ConnStatus, GuiState, RcApi } from "../shared";
import { ChatView, Composer } from "./chat";
import { FilesPanel } from "./files-panel";
import { ScreenView } from "./screen";
import { TerminalView } from "./terminal";
import { TimelineView } from "./timeline";
import { TransfersView } from "./transfers";

declare global {
  interface Window {
    rc: RcApi;
  }
}

const rc = window.rc;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let claudeState: ClaudeState = "unknown";

interface Views {
  term: TerminalView;
  screen: ScreenView;
  timeline: TimelineView;
  transfers: TransfersView;
  chat: ChatView;
  composer: Composer;
  files: FilesPanel;
}
let views: Views | null = null;

// ---------- 提示条 ----------

let toastTimer: number | null = null;
function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 5000);
}

// ---------- 顶栏徽章 ----------

const CONN_TEXT: Record<ConnStatus["state"], [string, string]> = {
  disconnected: ["未连接", ""],
  connecting: ["连接中…", "info"],
  connected: ["已连接", "ok"],
  reconnecting: ["重连中", "warn"],
  fatal: ["连接被拒绝", "bad"],
};

function renderConn(c: ConnStatus) {
  const [text, cls] = CONN_TEXT[c.state];
  const badge = $("conn-badge");
  badge.className = `badge ${cls}`;
  badge.textContent = c.detail ? `${text} · ${c.detail}` : text;
  const online = c.state === "connected";
  views?.term.setOnline(online);
  views?.screen.setOnline(online);
}

function renderClaude(s: ClaudeState) {
  claudeState = s;
  const badge = $("claude-badge");
  const cls = { idle: "ok", busy: "info", awaiting_input: "attention", stopped: "bad", unknown: "" }[s] ?? "";
  badge.className = `badge ${cls}`;
  badge.textContent = `Claude：${claudeStateText(s)}`;
  document.title = s === "awaiting_input" ? "● Remote Claude — 等你确认" : "Remote Claude";
  views?.composer.setClaudeState(s);
}

// ---------- 配对页 ----------

function showPair() {
  $("app").hidden = true;
  $("pair-view").hidden = false;
  $<HTMLInputElement>("pair-url").focus();
}

$<HTMLFormElement>("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>("pair-submit");
  const err = $("pair-error");
  btn.disabled = true;
  err.textContent = "";
  const r = await rc.pair(
    $<HTMLInputElement>("pair-url").value,
    $<HTMLInputElement>("pair-code").value,
    $<HTMLInputElement>("pair-name").value,
  );
  btn.disabled = false;
  if (!r.ok) {
    err.textContent = r.error;
    return;
  }
  showApp(await rc.getState());
});

// ---------- 主界面 ----------

function showApp(state: GuiState) {
  $("pair-view").hidden = true;
  $("app").hidden = false;
  $("daemon-name").textContent = state.profile ? `· ${state.profile.daemonName}` : "";

  if (!views) {
    const chat = new ChatView($("chat"), rc);
    views = {
      term: new TerminalView($("terminal"), $("term-status"), rc),
      screen: new ScreenView($("screen"), $("screen-status"), rc),
      timeline: new TimelineView($("timeline")),
      transfers: new TransfersView($("transfers"), $("transfer-count")),
      chat,
      composer: new Composer($("composer"), rc, chat, toast),
      files: new FilesPanel($("files"), rc, toast),
    };
  }
  views.timeline.clear();
  for (const ev of state.events) {
    views.timeline.add(ev);
    views.transfers.handle("up", ev.body);
  }
  views.chat.snapshot(state.chat);
  views.chat.restorePermissions(state.events);
  views.composer.setAttachments(state.attachments);
  renderClaude(state.claudeState);
  renderConn(state.conn);
  views.composer.focus();
}

rc.onConn(renderConn);
rc.onClaudeState(renderClaude);
rc.onEvent((ev) => {
  views?.timeline.add(ev);
  views?.transfers.handle("up", ev.body);
  views?.chat.onEvent(ev);
});
rc.onReset(() => {
  views?.timeline.clear();
  views?.timeline.divider("daemon 重启过或断线太久，时间线从这里重新开始");
});
rc.onLocalSync((b) => {
  views?.transfers.handle("down", b);
  if (b.t === "file.ready") void views?.files.refresh();
});
rc.onChatSnapshot((c) => views?.chat.snapshot(c));
rc.onChatAppend((a) => views?.chat.appendFromServer(a.sessionId, a.items));
rc.onAttachments((list) => views?.composer.setAttachments(list));

// 左侧：对话 / 终端
function showLeft(which: "chat" | "term") {
  for (const t of document.querySelectorAll<HTMLElement>(".ltab")) t.classList.toggle("active", t.dataset.ltab === which);
  for (const p of document.querySelectorAll<HTMLElement>("[data-lpanel]")) p.hidden = p.dataset.lpanel !== which;
  if (which === "term") views?.term.focus();
  else views?.composer.focus();
}
for (const tab of document.querySelectorAll<HTMLButtonElement>(".ltab")) {
  tab.addEventListener("click", () => showLeft(tab.dataset.ltab as "chat" | "term"));
}

// 右下：时间线 / 传输 / 文件
for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab[data-tab]")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab[data-tab]")) t.classList.toggle("active", t === tab);
    for (const p of document.querySelectorAll<HTMLElement>("[data-panel]")) p.hidden = p.dataset.panel !== tab.dataset.tab;
    views?.files.setVisible(tab.dataset.tab === "files");
  });
}

// ---------- 拖入文件 ----------
// 整个窗口都可以接收拖入；必须对 dragover/drop 调用 preventDefault，
// 否则浏览器的默认行为是"打开这个文件"（主进程那边也拦了导航，双保险）。

let dragDepth = 0;
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || $("app").hidden) return;
  dragDepth++;
  $("drop-overlay").hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop-overlay").hidden = true;
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-overlay").hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length || !views) return;
  showLeft("chat");
  void views.composer.addFiles(files);
});

// "我来操作"
$<HTMLInputElement>("takeover").addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  if (box.checked && claudeState === "busy") {
    const ok = confirm(
      "Claude 正在工作。\n\n你在画面里的操作 Claude 不会知道，它记着的页面状态会过时，下一步可能点错。\n" +
        "建议先在终端按 Esc 让它停下。\n\n仍然要接管吗？",
    );
    if (!ok) {
      box.checked = false;
      return;
    }
  }
  views?.screen.setViewOnly(!box.checked);
});

$("btn-folder").addEventListener("click", async () => {
  const err = await rc.openLocalFolder();
  if (err) toast(err);
});

// ---------- 设置 ----------

const dlg = $<HTMLDialogElement>("settings-dialog");

$("btn-settings").addEventListener("click", async () => {
  const s = await rc.getState();
  $<HTMLInputElement>("set-folder").value = s.settings.localFolder ?? "";
  $<HTMLInputElement>("set-st-url").value = s.settings.localSyncthing?.url ?? "http://127.0.0.1:8384";
  $<HTMLInputElement>("set-st-key").value = s.settings.localSyncthing?.apiKey ?? "";
  $("set-device").textContent = s.profile ? `已配对：${s.profile.daemonName}（${s.profile.url}），设备 id ${s.profile.deviceId}` : "";
  $("set-key").textContent =
    s.keyProtection === "os-keychain"
      ? "设备私钥由系统钥匙串加密保存。"
      : "⚠ 系统没有可用的钥匙串服务，设备私钥以明文文件保存（权限 0600）。";
  dlg.showModal();
});

$("set-folder-choose").addEventListener("click", async () => {
  const p = await rc.chooseLocalFolder();
  if (p) $<HTMLInputElement>("set-folder").value = p;
});

dlg.addEventListener("close", async () => {
  if (dlg.returnValue !== "save") return;
  const url = $<HTMLInputElement>("set-st-url").value.trim();
  const apiKey = $<HTMLInputElement>("set-st-key").value.trim();
  const folder = $<HTMLInputElement>("set-folder").value.trim();
  await rc.saveSettings({
    ...(url && apiKey ? { localSyncthing: { url, apiKey } } : {}),
    ...(folder ? { localFolder: folder } : {}),
  });
});

$("set-unpair").addEventListener("click", async () => {
  if (!confirm("解除配对后需要在远程重新生成配对码才能再连上。确定吗？")) return;
  dlg.close();
  await rc.unpair();
  location.reload();
});

// ---------- 启动 ----------

void (async () => {
  const state = await rc.getState();
  if (state.profile) showApp(state);
  else showPair();
})();
