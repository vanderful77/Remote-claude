import * as rfbModule from "@novnc/novnc/lib/rfb";

// noVNC 的 lib/ 是 Babel 转出来的 CommonJS（exports.default = RFB），
// 打包成 ESM 后默认导出可能多包一层，这里兼容两种形态。
const RFB: any = (rfbModule as any).default?.default ?? (rfbModule as any).default ?? rfbModule;
import type { RcApi } from "../shared";

/**
 * 远程画面：noVNC 直接连 daemon 的 /vnc（daemon 再转给远程 127.0.0.1 上的 VNC 服务端）。
 *
 * 默认"只看"：你和 Claude 看到的是同一个浏览器，但 Claude 读的是网页结构，你看的是像素。
 * 你在画面里点一下，Claude 并不知道，它记着的页面状态就过时了。
 * 所以要勾选"我来操作"才会把键鼠发过去。
 */
export class ScreenView {
  private rfb: any = null;
  private online = false;
  private viewOnly = true;
  private retryMs = 2000;
  private retryTimer: number | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly statusEl: HTMLElement,
    private readonly api: RcApi,
  ) {}

  setOnline(online: boolean) {
    this.online = online;
    if (online) {
      this.retryMs = 2000;
      void this.connect();
    } else {
      this.statusEl.textContent = "等待连接…";
    }
  }

  setViewOnly(v: boolean) {
    this.viewOnly = v;
    if (this.rfb) this.rfb.viewOnly = v;
  }

  private async connect() {
    if (!this.online || this.rfb) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.statusEl.textContent = "连接画面…";
    let url: string;
    try {
      url = await this.api.vncUrl();
    } catch {
      return this.scheduleRetry();
    }
    const rfb = new RFB(this.el, url, { wsProtocols: ["binary"] });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = this.viewOnly;
    rfb.background = "#000";
    rfb.qualityLevel = 6;
    rfb.compressionLevel = 2;
    this.rfb = rfb;
    rfb.addEventListener("connect", () => {
      this.retryMs = 2000;
      this.statusEl.textContent = "";
    });
    rfb.addEventListener("disconnect", () => {
      if (this.rfb === rfb) this.rfb = null;
      this.scheduleRetry();
    });
  }

  private scheduleRetry() {
    if (!this.online || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.statusEl.textContent = `画面已断开，${Math.round(delay / 1000)} 秒后重连`;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}
