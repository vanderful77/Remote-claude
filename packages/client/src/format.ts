import type { EventEnvelope } from "@rc/core";

function size(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

/** 把一个事件格式化成时间线上的一行 */
export function formatEvent(ev: EventEnvelope): string {
  const time = new Date(ev.ts).toLocaleTimeString("zh-CN", { hour12: false });
  const b = ev.body;
  let line: string;
  switch (b.t) {
    case "daemon.started":
      line = `daemon  启动 v${b.version}`;
      break;
    case "claude.hook":
      line = `claude  ${b.hook}${b.tool ? " " + b.tool : ""}${b.summary ? "  " + b.summary : ""}`;
      break;
    case "claude.state":
      line = `state   ${b.state}  (${b.reason})`;
      break;
    case "sync.item":
      line = `sync    ${b.phase === "started" ? "开始" : b.error ? "失败" : "完成"} ${b.action} ${b.folder}/${b.path}${b.error ? "  " + b.error : ""}`;
      break;
    case "sync.progress": {
      const pct = b.bytesTotal ? Math.floor((b.bytesDone / b.bytesTotal) * 100) : 0;
      line = `sync    ↓ ${b.folder}/${b.path} ${pct}% (${size(b.bytesDone)}/${size(b.bytesTotal)})`;
      break;
    }
    case "sync.folder":
      line = `sync    文件夹 ${b.folder}: ${b.state}`;
      break;
    case "sync.connection":
      line = `sync    Syncthing ${b.status === "up" ? "已连接" : "连接断开"}${b.error ? "  " + b.error : ""}`;
      break;
    case "file.ready":
      line = `ready   ${b.folder}/${b.path}`;
      break;
    default:
      line = JSON.stringify(b);
  }
  return `${time} #${ev.seq} ${line}`;
}
