import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { EventBody } from "@rc/core";
import type { Attachment, FileEntry } from "./shared";

/**
 * 本地同步文件夹的操作：把拖进来的文件放进 inbox/、跟踪它传到远程的进度、列出文件、校验路径。
 *
 * 为什么不直接把文件从本地上传到 daemon：文件层已经交给 Syncthing（块级续传、校验、双向），
 * 这里只是把"拖进来"翻译成"放进同步文件夹"，然后看着 Syncthing 把它送过去。
 */

const MAX_PASTE_BYTES = 50 * 1024 * 1024;
const LIST_DIRS = ["outbox", "inbox"];
const LIST_LIMIT = 500;

function isSyncthingTemp(name: string) {
  return name.startsWith(".syncthing.") || name.startsWith("~syncthing~") || name === ".stversions" || name === ".stfolder" || name.startsWith(".");
}

/** 去掉路径成分和控制字符，保留原文件名（包括中文） */
export function safeName(name: string): string {
  const base = basename(String(name)).replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").trim();
  return (base || "file").slice(0, 200);
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  for (let i = 1; existsSync(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

export class LocalFolder {
  private attachments = new Map<string, Attachment>();

  constructor(
    private readonly getFolder: () => string | undefined,
    private readonly onChange: (list: Attachment[]) => void,
    /** 让本地 Syncthing 立刻扫描某个路径（省掉默认约 10 秒的检测延迟） */
    private readonly triggerScan: (rel: string) => Promise<void>,
  ) {}

  list(): Attachment[] {
    return [...this.attachments.values()];
  }

  private changed() {
    this.onChange(this.list());
  }

  private folderOrThrow(): string {
    const f = this.getFolder();
    if (!f) throw new Error("还没有设置本地同步文件夹（设置 → 本地同步文件夹）");
    if (!existsSync(f)) throw new Error(`本地同步文件夹不存在：${f}`);
    return f;
  }

  /** 把相对路径解析成同步文件夹里的绝对路径；越界（../、符号链接指到外面）则抛错 */
  async resolveRel(rel: string): Promise<string> {
    const root = await realpath(this.folderOrThrow());
    const abs = resolve(root, String(rel));
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error("路径越界");
    const real = await realpath(abs);
    if (real !== root && !real.startsWith(root + sep)) throw new Error("路径越界");
    return real;
  }

  async attachPaths(paths: string[]): Promise<void> {
    const folder = this.folderOrThrow();
    const inbox = join(folder, "inbox");
    await mkdir(inbox, { recursive: true });
    for (const src of paths) {
      const st = await stat(src);
      if (!st.isFile()) throw new Error(`暂不支持文件夹：${basename(src)}`);
      const dest = await uniquePath(inbox, safeName(basename(src)));
      const att = this.add(dest, folder, st.size);
      // COPYFILE_FICLONE：文件系统支持写时复制（APFS、Btrfs、ReFS）时几乎不占额外空间，否则退回普通复制
      void copyFile(src, dest, constants.COPYFILE_FICLONE)
        .then(() => this.copied(att))
        .catch((e) => this.fail(att, `复制失败：${e.message}`));
    }
  }

  async attachData(name: string, data: Uint8Array): Promise<void> {
    if (data.byteLength > MAX_PASTE_BYTES) throw new Error("粘贴的内容太大（上限 50 MB），请把文件拖进来");
    const folder = this.folderOrThrow();
    const inbox = join(folder, "inbox");
    await mkdir(inbox, { recursive: true });
    const dest = await uniquePath(inbox, safeName(name));
    const att = this.add(dest, folder, data.byteLength);
    await writeFile(dest, data);
    await this.copied(att);
  }

  remove(id: string) {
    this.attachments.delete(id);
    this.changed();
  }

  /** 发送消息后清掉已就绪的附件 */
  clearReady() {
    for (const [id, a] of this.attachments) if (a.state === "ready") this.attachments.delete(id);
    this.changed();
  }

  private add(dest: string, folder: string, size: number): Attachment {
    const rel = relative(folder, dest).split(sep).join("/");
    const att: Attachment = { id: randomUUID(), name: basename(dest), rel, size, state: "copying", progress: 0 };
    this.attachments.set(att.id, att);
    this.changed();
    return att;
  }

  private async copied(att: Attachment) {
    att.state = "syncing";
    this.changed();
    await this.triggerScan(att.rel).catch(() => {});
  }

  private fail(att: Attachment, error: string) {
    att.state = "failed";
    att.error = error;
    this.changed();
  }

  /** 远程 daemon 转来的 Syncthing 事件：远程正在接收我们放进去的文件 */
  onRemoteEvent(b: EventBody) {
    if (b.t !== "sync.progress" && b.t !== "file.ready" && b.t !== "sync.item") return;
    for (const att of this.attachments.values()) {
      if (att.rel !== b.path || att.state === "ready") continue;
      if (b.t === "sync.progress" && b.bytesTotal) {
        att.progress = Math.min(0.99, b.bytesDone / b.bytesTotal);
        att.state = "syncing";
      } else if (b.t === "file.ready") {
        att.state = "ready";
        att.progress = 1;
        if (b.absPath) att.remotePath = b.absPath;
      } else if (b.t === "sync.item" && b.phase === "finished" && b.error) {
        att.state = "failed";
        att.error = b.error;
      }
      this.changed();
    }
  }

  async listFiles(): Promise<{ folder: string | null; files: FileEntry[] }> {
    const folder = this.getFolder();
    if (!folder || !existsSync(folder)) return { folder: folder ?? null, files: [] };
    const out: FileEntry[] = [];
    const walk = async (dir: string, top: string, depth: number) => {
      if (out.length >= LIST_LIMIT || depth > 3) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (isSyncthingTemp(e.name)) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) await walk(abs, top, depth + 1);
        else if (e.isFile()) {
          const st = await stat(abs).catch(() => null);
          if (!st) continue;
          out.push({ rel: relative(folder, abs).split(sep).join("/"), name: e.name, dir: top, size: st.size, mtime: st.mtimeMs });
          if (out.length >= LIST_LIMIT) return;
        }
      }
    };
    for (const d of LIST_DIRS) await walk(join(folder, d), d, 0);
    out.sort((a, b) => b.mtime - a.mtime);
    return { folder, files: out };
  }
}
