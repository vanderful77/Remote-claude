import { marked } from "marked";
import DOMPurify from "dompurify";
import type { ChatItem, ClaudeState, EventEnvelope } from "@rc/core";
import { claudeStateText, formatSize } from "@rc/client/format";
import type { Attachment, ChatState, RcApi } from "../shared";

/**
 * 对话视图（类似 Claude 网页版）。
 *
 * 数据来源：daemon 从 Claude Code 的会话记录里解析出来的对话项。Claude 本身仍然运行在远程 tmux 的终端里，
 * 这里只是换一种方式"看"同一个会话；输入框里的消息由 daemon 粘贴进终端。
 *
 * 安全：Claude 的回复和工具结果可能包含来自网页的恶意内容（提示词注入）。
 * Markdown 渲染后一律经过 DOMPurify 净化；其他文本一律用 textContent。
 */

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input", "img", "iframe"], FORBID_ATTR: ["style"] });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pretty(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Claude Code 输入框里引用文件的写法：路径没有空白就用 @路径，否则用引号括起来 */
export function fileRef(a: Attachment): string {
  const p = a.remotePath ?? a.rel;
  return /\s/.test(p) ? `"${p}"` : `@${p}`;
}

export class ChatView {
  private listEl: HTMLElement;
  private permsEl: HTMLElement;
  private sessionId: string | null = null;
  private toolEls = new Map<string, HTMLDetailsElement>();
  private seen = new Set<string>();
  private pendingPerms = new Map<string, HTMLElement>();
  private queued = new Map<string, HTMLElement>();

  constructor(
    root: HTMLElement,
    private readonly api: RcApi,
  ) {
    this.listEl = root.querySelector(".chat-list")!;
    this.permsEl = root.querySelector(".chat-perms")!;
  }

  private atBottom() {
    return this.listEl.scrollTop + this.listEl.clientHeight >= this.listEl.scrollHeight - 24;
  }

  snapshot(c: ChatState) {
    this.sessionId = c.sessionId;
    this.listEl.replaceChildren();
    this.toolEls.clear();
    this.seen.clear();
    if (!c.items.length) this.renderEmpty(c.sessionId);
    this.append(c.items, true);
  }

  appendFromServer(sessionId: string, items: ChatItem[]) {
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.listEl.replaceChildren();
      this.toolEls.clear();
      this.seen.clear();
    }
    this.append(items, false);
  }

  private renderEmpty(sessionId: string | null) {
    const box = el("div", "chat-empty");
    box.append(el("p", "", "还没有对话。在下面输入，或者把文件拖进来交给 Claude。"));
    if (!sessionId)
      box.append(
        el("p", "muted small", "对话视图需要远程配置 Claude Code hooks（rcd hooks-config）。配置之前，消息仍然可以发送，回复请在“终端”里看。"),
      );
    this.listEl.append(box);
  }

  private append(items: ChatItem[], forceScroll: boolean) {
    const stick = forceScroll || this.atBottom();
    this.listEl.querySelector(".chat-empty")?.remove();
    for (const it of items) {
      if (this.seen.has(it.id)) continue;
      this.seen.add(it.id);
      this.renderItem(it);
    }
    // 真实的用户消息出现了，对应的"排队中"占位就可以去掉
    if (items.some((i) => i.k === "user")) for (const q of this.queued.values()) if (q.dataset.sent === "1") q.remove();
    if (stick) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private renderItem(it: ChatItem) {
    switch (it.k) {
      case "user": {
        const b = el("div", "msg user");
        b.append(el("div", "bubble", it.text));
        this.listEl.append(b);
        return;
      }
      case "note":
        this.listEl.append(el("div", "msg note", it.text));
        return;
      case "assistant": {
        const b = el("div", "msg assistant");
        const body = el("div", "md");
        body.innerHTML = renderMarkdown(it.text);
        b.append(body);
        this.listEl.append(b);
        return;
      }
      case "tool_use": {
        const d = el("details", "tool");
        const sum = el("summary");
        sum.append(el("span", "tool-name", it.name), el("span", "tool-summary", it.summary ?? ""), el("span", "tool-status", "运行中…"));
        d.append(sum);
        const input = el("pre", "tool-input", pretty(it.input));
        d.append(input);
        this.toolEls.set(it.toolId, d);
        this.listEl.append(d);
        return;
      }
      case "tool_result": {
        const d = this.toolEls.get(it.toolId);
        const pre = el("pre", `tool-result${it.isError ? " error" : ""}`, it.text || "（无输出）");
        if (!d) {
          // 找不到对应的调用（例如快照被截断），单独显示
          const orphan = el("details", "tool");
          orphan.append(el("summary", "", "工具结果"), pre);
          this.listEl.append(orphan);
          return;
        }
        d.append(pre);
        d.classList.toggle("error", it.isError);
        const status = d.querySelector(".tool-status");
        if (status) status.textContent = it.isError ? "出错" : "完成";
        return;
      }
    }
  }

  /** 已发送但 Claude 还没处理（排队）的消息，先显示一个占位 */
  showQueued(id: string, text: string, status: "sent" | "queued") {
    const b = el("div", "msg user pending");
    b.append(el("div", "bubble", text), el("div", "pending-label", status === "queued" ? "排队中，Claude 完成当前任务后发送" : "已发送"));
    if (status === "sent") b.dataset.sent = "1";
    this.queued.set(id, b);
    this.listEl.append(b);
    this.listEl.scrollTop = this.listEl.scrollHeight;
    // 没有配置 hooks 时会话记录不会更新，占位过一会儿自己消失
    if (status === "sent") setTimeout(() => b.remove(), 15_000);
  }

  onEvent(ev: EventEnvelope) {
    const b = ev.body;
    if (b.t === "chat.input") {
      const q = this.queued.get(b.id);
      if (q && b.status === "sent") {
        q.dataset.sent = "1";
        const label = q.querySelector(".pending-label");
        if (label) label.textContent = "已发送";
        setTimeout(() => q.remove(), 15_000);
      }
      if (q && b.status === "dropped") {
        q.classList.add("failed");
        const label = q.querySelector(".pending-label");
        if (label) label.textContent = `发送失败：${b.reason ?? ""}`;
      }
    }
    if (b.t === "permission.request") this.showPermission(b.id, b.tool, b.summary, b.input);
    if (b.t === "permission.resolved") {
      this.pendingPerms.get(b.id)?.remove();
      this.pendingPerms.delete(b.id);
    }
  }

  private showPermission(id: string, tool: string, summary: string | undefined, input: unknown) {
    if (this.pendingPerms.has(id)) return;
    const card = el("div", "perm-card");
    const head = el("div", "perm-head");
    head.append(el("span", "perm-title", `Claude 想要使用 ${tool}`));
    card.append(head);
    if (summary) card.append(el("code", "perm-summary", summary));
    const details = el("details", "perm-details");
    details.append(el("summary", "", "完整参数"), el("pre", "", pretty(input)));
    card.append(details);
    const actions = el("div", "perm-actions");
    const allow = el("button", "perm-allow", "允许");
    const deny = el("button", "ghost perm-deny", "拒绝");
    const decide = (behavior: "allow" | "deny") => {
      allow.disabled = deny.disabled = true;
      void this.api.decidePermission(id, behavior);
    };
    allow.addEventListener("click", () => decide("allow"));
    deny.addEventListener("click", () => decide("deny"));
    actions.append(el("span", "muted small", "没人回答时约 2 分钟后转回终端确认"), allow, deny);
    card.append(actions);
    this.pendingPerms.set(id, card);
    this.permsEl.append(card);
  }

  /** 初始状态：从历史事件里找出还没结束的权限请求 */
  restorePermissions(events: EventEnvelope[]) {
    const open = new Map<string, EventEnvelope>();
    for (const e of events) {
      if (e.body.t === "permission.request") open.set(e.body.id, e);
      if (e.body.t === "permission.resolved") open.delete(e.body.id);
    }
    for (const e of open.values()) this.onEvent(e);
  }
}

/**
 * 输入框：文字 + 附件。
 * 附件必须"就绪"（远程已完整收到）才能发送：否则 Claude 去读时文件还不存在或只有一半。
 * 按发送时附件还没就绪，就标记为"传完后自动发送"。
 */
export class Composer {
  private attachments: Attachment[] = [];
  private sendWhenReady = false;
  private claudeState: ClaudeState = "unknown";
  private textarea: HTMLTextAreaElement;
  private chipsEl: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private hintEl: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly api: RcApi,
    private readonly chat: ChatView,
    private readonly onError: (msg: string) => void,
  ) {
    this.textarea = root.querySelector("textarea")!;
    this.chipsEl = root.querySelector(".chips")!;
    this.sendBtn = root.querySelector(".send")!;
    this.hintEl = root.querySelector(".composer-hint")!;

    this.textarea.addEventListener("keydown", (e) => {
      // isComposing：中文输入法选词时按的回车不能当成发送
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });
    this.textarea.addEventListener("input", () => this.autosize());
    this.textarea.addEventListener("paste", (e) => void this.onPaste(e));
    this.sendBtn.addEventListener("click", () => void this.submit());

    const fileInput = root.querySelector<HTMLInputElement>("input[type=file]")!;
    root.querySelector(".attach")!.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      void this.addFiles([...(fileInput.files ?? [])]);
      fileInput.value = "";
    });
    this.render();
  }

  focus() {
    this.textarea.focus();
  }

  setClaudeState(s: ClaudeState) {
    this.claudeState = s;
    this.render();
  }

  setAttachments(list: Attachment[]) {
    this.attachments = list;
    this.render();
    if (this.sendWhenReady && list.length && list.every((a) => a.state === "ready")) void this.submit();
    if (this.sendWhenReady && list.some((a) => a.state === "failed")) this.sendWhenReady = false;
  }

  /** 拖拽、文件选择框、粘贴共用：有真实路径的走复制，没有的（粘贴的截图）读出数据再写 */
  async addFiles(files: File[]) {
    const paths: string[] = [];
    for (const f of files) {
      const p = this.api.pathForFile(f);
      if (p) paths.push(p);
      else {
        const r = await this.api.attachData(f.name || "粘贴的文件", new Uint8Array(await f.arrayBuffer()));
        if (r.error) this.onError(r.error);
      }
    }
    if (paths.length) {
      const r = await this.api.attachPaths(paths);
      if (r.error) this.onError(r.error);
    }
    this.textarea.focus();
  }

  private async onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const named = files.map((f, i) =>
      f.type.startsWith("image/") && (!f.name || f.name === "image.png")
        ? new File([f], `截图-${stamp}${i ? "-" + i : ""}.png`, { type: f.type })
        : f,
    );
    await this.addFiles(named);
  }

  private autosize() {
    this.textarea.style.height = "auto";
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 220)}px`;
  }

  private render() {
    this.chipsEl.replaceChildren();
    for (const a of this.attachments) {
      const chip = el("div", `chip ${a.state}`);
      const label =
        a.state === "ready"
          ? "已就绪"
          : a.state === "failed"
            ? `失败：${a.error ?? ""}`
            : a.state === "copying"
              ? "准备中…"
              : `传输中 ${Math.floor(a.progress * 100)}%`;
      chip.append(el("span", "chip-name", a.name), el("span", "chip-meta", `${formatSize(a.size)} · ${label}`));
      const bar = el("div", "chip-bar");
      const fill = el("div");
      fill.style.width = `${(a.state === "ready" ? 1 : a.progress) * 100}%`;
      bar.append(fill);
      chip.append(bar);
      const x = el("button", "chip-x", "×");
      x.title = "移除";
      x.addEventListener("click", () => void this.api.removeAttachment(a.id));
      chip.append(x);
      this.chipsEl.append(chip);
    }
    const waiting = this.attachments.filter((a) => a.state === "copying" || a.state === "syncing").length;
    this.sendBtn.textContent = this.sendWhenReady ? "传完后自动发送" : "发送";
    this.sendBtn.classList.toggle("waiting", this.sendWhenReady);
    const st =
      this.claudeState === "busy"
        ? "Claude 正在工作，现在发送会排队，等它完成这一轮再送达"
        : this.claudeState === "awaiting_input"
          ? "Claude 在等你确认权限，先回答上面的请求；现在发送会排队"
          : `Claude：${claudeStateText(this.claudeState)}`;
    this.hintEl.textContent = waiting ? `${waiting} 个文件还在传输，传完才能让 Claude 读取 · ${st}` : st;
  }

  async submit() {
    const text = this.textarea.value.trim();
    const live = this.attachments.filter((a) => a.state !== "failed");
    if (!text && !live.length) return;
    if (live.some((a) => a.state !== "ready")) {
      this.sendWhenReady = true;
      this.render();
      return;
    }
    this.sendWhenReady = false;
    const refs = live.map(fileRef);
    const message = [refs.join(" "), text].filter(Boolean).join(" ");
    this.sendBtn.disabled = true;
    try {
      const r = await this.api.sendChat(message);
      if (r.status === "rejected") {
        this.onError(`发送失败：${r.reason ?? ""}`);
        return;
      }
      this.chat.showQueued(r.id ?? `${Date.now()}`, message, r.status);
      this.textarea.value = "";
      this.autosize();
    } catch (e) {
      this.onError(`发送失败：${(e as Error).message}`);
    } finally {
      this.sendBtn.disabled = false;
      this.render();
    }
  }
}
