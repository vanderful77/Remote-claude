import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { RcApi } from "../shared";

/**
 * Claude 终端：xterm.js 直接连 daemon 的 /term。
 * 每次连接都是远程一个新的 `tmux attach`，连上后 tmux 会把当前屏幕完整画一遍，
 * 所以断线重连后不需要我们自己恢复画面。
 */
export class TerminalView {
  private term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    theme: { background: "#15171c", foreground: "#e6e8ec", cursor: "#f97316", selectionBackground: "#3b4250" },
  });
  private fit = new FitAddon();
  private ws: WebSocket | null = null;
  private online = false;
  private retryMs = 1000;
  private retryTimer: number | null = null;
  private encoder = new TextEncoder();

  constructor(
    private readonly el: HTMLElement,
    private readonly statusEl: HTMLElement,
    private readonly api: RcApi,
  ) {
    this.term.loadAddon(this.fit);
    this.term.open(el);
    this.safeFit();

    this.term.onData((d) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.encoder.encode(d));
    });

    let resizeTimer: number | null = null;
    new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        this.safeFit();
        this.sendResize();
      }, 80);
    }).observe(el);
  }

  focus() {
    this.term.focus();
  }

  private safeFit() {
    try {
      this.fit.fit();
    } catch {
      /* 容器尺寸为 0 时 */
    }
  }

  private sendResize() {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ type: "resize", cols: this.term.cols, rows: this.term.rows }));
  }

  private status(text: string) {
    this.statusEl.textContent = text;
  }

  /** 控制通道连上/断开时由 app 调用 */
  setOnline(online: boolean) {
    this.online = online;
    if (online) {
      this.retryMs = 1000;
      void this.connect();
    } else {
      this.status("等待连接…");
    }
  }

  private async connect() {
    if (!this.online || this.ws) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.status("接入中…");
    let url: string;
    try {
      url = await this.api.termUrl(this.term.cols, this.term.rows);
    } catch {
      return this.scheduleRetry();
    }
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      this.status("");
      this.sendResize();
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.term.write(new Uint8Array(e.data));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.status("终端已断开，Claude 仍在远程运行");
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (!this.online || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
    this.status(`终端已断开，${Math.round(delay / 1000)} 秒后重新接入（Claude 仍在远程运行）`);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}
