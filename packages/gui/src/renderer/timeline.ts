import type { EventEnvelope } from "@rc/core";
import { describeEvent } from "@rc/client/format";

const MAX_ROWS = 1000;
const KIND_LABEL: Record<string, string> = {
  daemon: "daemon",
  claude: "Claude",
  state: "状态",
  sync: "同步",
  ready: "就绪",
};

/**
 * 事件时间线。
 * 所有文本都用 textContent 插入：文件名、命令、提示词都来自远程，可能包含恶意内容。
 */
export class TimelineView {
  constructor(private readonly el: HTMLElement) {}

  /** 进度事件太密，时间线上不显示（传输面板里看） */
  add(ev: EventEnvelope) {
    if (ev.body.t === "sync.progress") return;
    const stick = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 8;
    const d = describeEvent(ev.body);
    const row = document.createElement("div");
    row.className = `ev ${d.kind}${d.error ? " error" : ""}`;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = new Date(ev.ts).toLocaleTimeString("zh-CN", { hour12: false });
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = KIND_LABEL[d.kind] ?? d.kind;
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = d.text;
    text.title = d.text;
    row.append(time, kind, text);
    this.el.append(row);
    while (this.el.childElementCount > MAX_ROWS) this.el.firstElementChild?.remove();
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }

  divider(text: string) {
    const row = document.createElement("div");
    row.className = "ev divider";
    row.textContent = text;
    this.el.append(row);
  }

  clear() {
    this.el.replaceChildren();
  }
}
