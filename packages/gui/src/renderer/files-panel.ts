import { formatSize } from "@rc/client/format";
import type { FileEntry, RcApi } from "../shared";

/**
 * 文件面板：本地同步文件夹里 outbox/（Claude 的产出）和 inbox/（你交给 Claude 的）的文件。
 * 双击用本地应用打开；按住拖到桌面、邮件、聊天窗口就是一个真实文件。
 */
export class FilesPanel {
  private timer: number | null = null;
  private lastKey = "";

  constructor(
    private readonly el: HTMLElement,
    private readonly api: RcApi,
    private readonly onError: (m: string) => void,
  ) {}

  /** 面板可见时每 3 秒刷新一次 */
  setVisible(v: boolean) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (v) {
      void this.refresh();
      this.timer = window.setInterval(() => void this.refresh(), 3000);
    }
  }

  async refresh() {
    const { folder, files } = await this.api.listFiles();
    const key = JSON.stringify([folder, files.map((f) => [f.rel, f.size, f.mtime])]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.el.replaceChildren();
    if (!folder) {
      this.el.append(this.p("还没有设置本地同步文件夹（设置 → 本地同步文件夹）。"));
      return;
    }
    if (!files.length) {
      this.el.append(this.p("outbox/ 和 inbox/ 里还没有文件。Claude 写到 outbox/ 的产出会出现在这里。"));
      return;
    }
    for (const dir of ["outbox", "inbox"]) {
      const group = files.filter((f) => f.dir === dir);
      if (!group.length) continue;
      const h = document.createElement("div");
      h.className = "files-head";
      h.textContent = dir === "outbox" ? "Claude 的产出（outbox）" : "交给 Claude 的（inbox）";
      this.el.append(h);
      for (const f of group) this.el.append(this.row(f));
    }
  }

  private p(text: string) {
    const e = document.createElement("p");
    e.className = "muted empty";
    e.textContent = text;
    return e;
  }

  private row(f: FileEntry) {
    const row = document.createElement("div");
    row.className = "file-row";
    row.draggable = true;
    row.title = "双击打开 · 拖到桌面或其他应用";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = f.rel.slice(f.dir.length + 1);
    const meta = document.createElement("span");
    meta.className = "file-meta";
    meta.textContent = `${formatSize(f.size)} · ${new Date(f.mtime).toLocaleString("zh-CN", { hour12: false })}`;
    const reveal = document.createElement("button");
    reveal.className = "ghost small-btn";
    reveal.textContent = "显示";
    reveal.title = "在文件夹中显示";
    reveal.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.api.revealFile(f.rel);
    });
    row.append(name, meta, reveal);
    row.addEventListener("dblclick", async () => {
      const err = await this.api.openFile(f.rel);
      if (err) this.onError(err);
    });
    row.addEventListener("dragstart", (e) => {
      // 交给系统做真正的文件拖拽（Electron startDrag），而不是浏览器内部的拖拽
      e.preventDefault();
      this.api.startDrag(f.rel);
    });
    return row;
  }
}
