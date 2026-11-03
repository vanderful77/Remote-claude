import type { ClaudeState } from "@rc/core";
import { claudeStateText } from "@rc/client/format";
import type { ConnStatus, GuiState, RcApi } from "../shared";
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
let views: { term: TerminalView; screen: ScreenView; timeline: TimelineView; transfers: TransfersView } | null = null;

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
    views = {
      term: new TerminalView($("terminal"), $("term-status"), rc),
      screen: new ScreenView($("screen"), $("screen-status"), rc),
      timeline: new TimelineView($("timeline")),
      transfers: new TransfersView($("transfers"), $("transfer-count")),
    };
  }
  views.timeline.clear();
  for (const ev of state.events) {
    views.timeline.add(ev);
    views.transfers.handle("up", ev.body);
  }
  renderClaude(state.claudeState);
  renderConn(state.conn);
  views.term.focus();
}

rc.onConn(renderConn);
rc.onClaudeState(renderClaude);
rc.onEvent((ev) => {
  views?.timeline.add(ev);
  views?.transfers.handle("up", ev.body);
});
rc.onReset(() => {
  views?.timeline.clear();
  views?.timeline.divider("daemon 重启过或断线太久，时间线从这里重新开始");
});
rc.onLocalSync((b) => views?.transfers.handle("down", b));

// 标签页
for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    for (const p of document.querySelectorAll<HTMLElement>("[data-panel]")) p.hidden = p.dataset.panel !== tab.dataset.tab;
  });
}

// "我来操作"
$<HTMLInputElement>("takeover").addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  if (box.checked && claudeState === "busy") {
    const ok = confirm(
      "Claude 正在工作。\n\n你在画面里的操作 Claude 不会知道，它记着的页面状态会过时，下一步可能点错。\n" +
        "建议先在左边终端按 Esc 让它停下。\n\n仍然要接管吗？",
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
  if (err) alert(err);
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
