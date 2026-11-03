import type { EventBody } from "@rc/core";
import { formatSize } from "@rc/client/format";

/**
 * 传输面板。数据来自两边的 Syncthing：
 * - 远程 daemon 转来的事件：远程 Syncthing 正在"接收"，即 本地 → 远程（↑）
 * - 本地 Syncthing 的事件（设置里配置后）：本地正在接收，即 远程 → 本地（↓）
 */

type Dir = "up" | "down";

interface Item {
  key: string;
  dir: Dir;
  folder: string;
  path: string;
  done: number;
  total: number;
  state: "active" | "done" | "failed";
  error?: string;
  speed: number;
  lastBytes: number;
  lastTs: number;
  finishedAt?: number;
  row: HTMLElement;
}

const MAX_ITEMS = 200;

export class TransfersView {
  private items = new Map<string, Item>();

  constructor(
    private readonly el: HTMLElement,
    private readonly countEl: HTMLElement,
  ) {}

  handle(dir: Dir, b: EventBody) {
    switch (b.t) {
      case "sync.item": {
        if (b.action !== "update") return;
        const it = this.get(dir, b.folder, b.path);
        if (b.phase === "finished") {
          it.state = b.error ? "failed" : "done";
          it.error = b.error;
          it.finishedAt = Date.now();
          if (!b.error && it.total) it.done = it.total;
        } else {
          it.state = "active";
        }
        this.render(it);
        break;
      }
      case "sync.progress": {
        const it = this.get(dir, b.folder, b.path);
        const now = Date.now();
        if (it.lastTs && b.bytesDone >= it.lastBytes && now > it.lastTs) {
          const inst = ((b.bytesDone - it.lastBytes) / (now - it.lastTs)) * 1000;
          // 指数移动平均：不然速度数字会跳得厉害
          it.speed = it.speed ? it.speed * 0.7 + inst * 0.3 : inst;
        }
        it.lastBytes = b.bytesDone;
        it.lastTs = now;
        it.done = b.bytesDone;
        it.total = b.bytesTotal;
        it.state = "active";
        this.render(it);
        break;
      }
      case "file.ready": {
        const it = this.get(dir, b.folder, b.path);
        it.state = "done";
        it.finishedAt ??= Date.now();
        if (it.total) it.done = it.total;
        this.render(it);
        break;
      }
    }
    this.updateCount();
  }

  private get(dir: Dir, folder: string, path: string): Item {
    const key = `${dir}\0${folder}\0${path}`;
    let it = this.items.get(key);
    if (it) return it;
    this.el.querySelector(".empty")?.remove();
    const row = document.createElement("div");
    row.className = "xfer";
    it = { key, dir, folder, path, done: 0, total: 0, state: "active", speed: 0, lastBytes: 0, lastTs: 0, row };
    this.items.set(key, it);
    this.el.prepend(row);
    if (this.items.size > MAX_ITEMS) {
      for (const [k, old] of this.items) {
        if (old.state !== "active") {
          old.row.remove();
          this.items.delete(k);
          break;
        }
      }
    }
    return it;
  }

  private render(it: Item) {
    it.row.className = `xfer ${it.state}`;
    const dir = document.createElement("span");
    dir.className = "dir";
    dir.textContent = it.dir === "up" ? "↑" : "↓";
    dir.title = it.dir === "up" ? "本地 → 远程" : "远程 → 本地";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${it.folder}/${it.path}`;
    name.title = name.textContent;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = this.metaText(it);
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    const pct = it.state === "done" ? 100 : it.total ? (it.done / it.total) * 100 : 0;
    fill.style.width = `${pct.toFixed(1)}%`;
    bar.append(fill);
    it.row.replaceChildren(dir, name, meta, bar);
  }

  private metaText(it: Item): string {
    if (it.state === "failed") return `失败：${it.error ?? ""}`;
    if (it.state === "done") {
      const t = new Date(it.finishedAt ?? Date.now()).toLocaleTimeString("zh-CN", { hour12: false });
      return `完成 ${t}${it.total ? " · " + formatSize(it.total) : ""}`;
    }
    if (!it.total) return "准备中…";
    const pct = Math.floor((it.done / it.total) * 100);
    let s = `${pct}% · ${formatSize(it.done)} / ${formatSize(it.total)}`;
    if (it.speed > 0) {
      const left = (it.total - it.done) / it.speed;
      s += ` · ${formatSize(it.speed)}/s · 剩余 ${left < 60 ? Math.ceil(left) + " 秒" : Math.ceil(left / 60) + " 分"}`;
    }
    return s;
  }

  private updateCount() {
    const n = [...this.items.values()].filter((i) => i.state === "active").length;
    this.countEl.textContent = n ? String(n) : "";
  }
}
