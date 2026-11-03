import { EventEmitter } from "node:events";
import { open, stat } from "node:fs/promises";
import { basename, sep } from "node:path";
import type { ChatItem } from "@rc/core";
import { sanitize } from "./hooks";

/**
 * Claude Code 会话记录（~/.claude/projects/<目录>/<session>.jsonl）的解析与跟踪。
 *
 * 文件里每行一个 JSON。我们只关心 type 为 "user" / "assistant" 的行：
 *   assistant：message.content 是内容块数组，**每行只有一个块**（同一条回复会拆成多行，共用 message.id）
 *              块类型：text、tool_use、thinking（跳过）
 *   user：     message.content 是字符串（你输入的提示词），或者内容块数组（tool_result、text）
 * 其他类型（attachment、system、mode、queue-operation……）一律跳过。
 *
 * 这是内部格式，官方不保证稳定。原则：认不出的字段和行一律跳过，绝不因为解析失败而中断。
 */

const MAX_TEXT = 50_000;
const MAX_RESULT = 4_000;
const MAX_ITEMS = 1500;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…（还有 ${s.length - max} 个字符）` : s;
}

function toolSummary(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const v =
    input.file_path ?? input.notebook_path ?? input.command ?? input.url ?? input.pattern ?? input.query ?? input.description;
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 200 ? t.slice(0, 200) + "…" : t;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : b?.type === "image" ? "[图片]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** 你自己输入的、但不该显示成普通气泡的内容 */
function isNote(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("[Request interrupted") ||
    t.startsWith("<command-") ||
    t.startsWith("<local-command") ||
    t.startsWith("<system-reminder>") ||
    t.startsWith("Caveat:")
  );
}

function noteText(text: string): string {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (name) return `执行命令 ${name.trim()}`;
  if (text.startsWith("[Request interrupted")) return "已中断";
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** 解析一行。返回 0 个或多个对话项 */
export function parseTranscriptLine(line: string): ChatItem[] {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (!j || (j.type !== "user" && j.type !== "assistant")) return [];
  if (j.isSidechain === true || j.isMeta === true) return [];
  const msg = j.message;
  if (!msg || typeof msg !== "object") return [];
  const ts = Date.parse(j.timestamp ?? "") || 0;
  const base = String(j.uuid ?? `${ts}-${Math.random()}`);
  const out: ChatItem[] = [];
  const content = msg.content;

  if (typeof content === "string") {
    if (j.type === "user") {
      out.push(isNote(content) ? { k: "note", id: base, ts, text: noteText(content) } : { k: "user", id: base, ts, text: clip(content, MAX_TEXT) });
    } else {
      out.push({ k: "assistant", id: base, ts, text: clip(content, MAX_TEXT) });
    }
    return out;
  }
  if (!Array.isArray(content)) return out;

  content.forEach((b: any, i: number) => {
    const id = `${base}:${i}`;
    if (!b || typeof b !== "object") return;
    switch (b.type) {
      case "text":
        if (typeof b.text !== "string" || !b.text.trim()) return;
        if (j.type === "user") {
          out.push(isNote(b.text) ? { k: "note", id, ts, text: noteText(b.text) } : { k: "user", id, ts, text: clip(b.text, MAX_TEXT) });
        } else {
          out.push({ k: "assistant", id, ts, text: clip(b.text, MAX_TEXT) });
        }
        return;
      case "tool_use":
        out.push({
          k: "tool_use",
          id,
          ts,
          toolId: String(b.id ?? id),
          name: String(b.name ?? "tool"),
          summary: toolSummary(b.input),
          input: sanitize(b.input),
        });
        return;
      case "tool_result":
        out.push({
          k: "tool_result",
          id,
          ts,
          toolId: String(b.tool_use_id ?? ""),
          isError: b.is_error === true,
          text: clip(resultText(b.content), MAX_RESULT),
        });
        return;
      // thinking、image 等：跳过
    }
  });
  return out;
}

/** 只接受看起来像会话记录的路径，避免任何本机进程借 hook 让 daemon 去读别的文件 */
export function isTranscriptPath(p: unknown): p is string {
  return typeof p === "string" && p.endsWith(".jsonl") && p.split(sep).includes("projects") && !p.includes("\0");
}

interface TailerEvents {
  snapshot: [sessionId: string | null, items: ChatItem[]];
  append: [sessionId: string, items: ChatItem[]];
}

/**
 * 跟踪当前会话记录文件：hook 告诉我们路径，之后每 500ms 检查文件是否变长，只读新增的部分。
 * 用轮询而不是 fs.watch：fs.watch 在不同系统、不同文件系统上的行为不一致，而 stat 一个文件几乎没有开销。
 */
export class TranscriptTailer extends EventEmitter<TailerEvents> {
  private path: string | null = null;
  private offset = 0;
  /** 上次读到的、还没遇到换行符的字节。按字节保存：一个汉字的 3 个字节可能被切在两次读取之间 */
  private partial: Buffer = Buffer.alloc(0);
  private items: ChatItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  private reading = false;

  constructor(private readonly intervalMs = 500) {
    super();
  }

  get sessionId(): string | null {
    return this.path ? basename(this.path, ".jsonl") : null;
  }

  snapshot(): { sessionId: string | null; items: ChatItem[] } {
    return { sessionId: this.sessionId, items: [...this.items] };
  }

  /** 切换到新的会话记录文件（路径没变则什么都不做） */
  follow(path: string): void {
    if (path === this.path) return;
    this.path = path;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.items = [];
    this.emit("snapshot", this.sessionId, []);
    if (!this.timer) this.timer = setInterval(() => void this.poll(), this.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (!this.path || this.reading) return;
    this.reading = true;
    const path = this.path;
    try {
      const st = await stat(path).catch(() => null);
      if (!st) return;
      if (st.size < this.offset) {
        // 文件变短了（被截断或替换）：从头再读
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        this.items = [];
        this.emit("snapshot", this.sessionId, []);
      }
      if (st.size === this.offset) return;
      const fh = await open(path, "r");
      try {
        const len = st.size - this.offset;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, this.offset);
        this.offset = st.size;
        const all = Buffer.concat([this.partial, buf]);
        const lastNl = all.lastIndexOf(0x0a);
        // 最后一个换行符之后是写了一半的行，留到下次
        this.partial = all.subarray(lastNl + 1);
        const lines = lastNl >= 0 ? all.subarray(0, lastNl).toString("utf8").split("\n") : [];
        const fresh: ChatItem[] = [];
        for (const line of lines) if (line.trim()) fresh.push(...parseTranscriptLine(line));
        if (path !== this.path || !fresh.length) return;
        this.items.push(...fresh);
        if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
        this.emit("append", this.sessionId!, fresh);
      } finally {
        await fh.close();
      }
    } finally {
      this.reading = false;
    }
  }
}
