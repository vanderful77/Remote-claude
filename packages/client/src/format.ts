import type { EventBody, EventEnvelope } from "@rc/core";

/**
 * 事件的人类可读描述。命令行和 GUI 共用（这个文件不依赖 Node，可以打包进浏览器端）。
 */

export function formatSize(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

export type EventKind = "daemon" | "claude" | "state" | "sync" | "ready";

export interface EventDescription {
  kind: EventKind;
  text: string;
  error?: boolean;
}

const STATE_TEXT: Record<string, string> = {
  unknown: "未知",
  idle: "空闲",
  busy: "工作中",
  awaiting_input: "等待你确认",
  stopped: "已退出",
};

export function claudeStateText(s: string): string {
  return STATE_TEXT[s] ?? s;
}

export function describeEvent(b: EventBody): EventDescription {
  switch (b.t) {
    case "daemon.started":
      return { kind: "daemon", text: `daemon 启动 v${b.version}` };
    case "claude.hook":
      return { kind: "claude", text: `${b.hook}${b.tool ? " " + b.tool : ""}${b.summary ? "  " + b.summary : ""}` };
    case "claude.state":
      return { kind: "state", text: `${claudeStateText(b.state)}  (${b.reason})` };
    case "sync.item":
      return {
        kind: "sync",
        text: `${b.phase === "started" ? "开始" : b.error ? "失败" : "完成"} ${b.action} ${b.folder}/${b.path}${b.error ? "  " + b.error : ""}`,
        error: !!b.error,
      };
    case "sync.progress": {
      const pct = b.bytesTotal ? Math.floor((b.bytesDone / b.bytesTotal) * 100) : 0;
      return { kind: "sync", text: `↓ ${b.folder}/${b.path} ${pct}% (${formatSize(b.bytesDone)}/${formatSize(b.bytesTotal)})` };
    }
    case "sync.folder":
      return { kind: "sync", text: `文件夹 ${b.folder}: ${b.state}` };
    case "sync.connection":
      return {
        kind: "sync",
        text: `Syncthing ${b.status === "up" ? "已连接" : "连接断开"}${b.error ? "  " + b.error : ""}`,
        error: b.status === "down",
      };
    case "file.ready":
      return { kind: "ready", text: `${b.folder}/${b.path}` };
    case "permission.request":
      return { kind: "state", text: `权限请求 ${b.tool}${b.summary ? "  " + b.summary : ""}` };
    case "permission.resolved":
      return {
        kind: "state",
        text: b.by === "timeout" ? "权限请求无人回答，转到终端确认" : `权限请求已${b.behavior === "allow" ? "允许" : "拒绝"}`,
      };
    case "chat.input":
      return {
        kind: "claude",
        text: `${b.status === "sent" ? "已发送" : b.status === "queued" ? "已排队" : "发送失败"}：${b.preview}${b.reason ? "  " + b.reason : ""}`,
        error: b.status === "dropped",
      };
    default:
      return { kind: "daemon", text: JSON.stringify(b) };
  }
}

/** 命令行用：一行文本 */
export function formatEvent(ev: EventEnvelope): string {
  const time = new Date(ev.ts).toLocaleTimeString("zh-CN", { hour12: false });
  const d = describeEvent(ev.body);
  return `${time} #${ev.seq} ${d.kind.padEnd(7)} ${d.text}`;
}
