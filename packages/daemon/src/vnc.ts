import { connect } from "node:net";
import type { WebSocket } from "ws";

/**
 * 画面通道：WebSocket <-> RFB(VNC) 的透明桥，相当于内置一个 websockify。
 *
 * VNC 服务端（TigerVNC 的 Xvnc，以后 Windows 上可以是 TightVNC）只监听 127.0.0.1，
 * 外面唯一能碰到它的路径就是经过 daemon 鉴权的这条 WebSocket。
 * 本地 GUI 里的 noVNC 直接连这条 WebSocket，说标准 VNC 协议，daemon 不解析内容。
 * 这样前端只认一种协议，远程换什么 VNC 服务端都不用改前端。
 */

const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

export function bridgeVnc(ws: WebSocket, target: { host: string; port: number }, log: (m: string) => void): void {
  const sock = connect(target.port, target.host);
  let drainTimer: NodeJS.Timeout | null = null;

  sock.on("data", (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, { binary: true });
    // 画面数据量大：网络跟不上时暂停读 VNC，让 VNC 服务端自己合并更新、降帧
    if (!drainTimer && ws.bufferedAmount > HIGH_WATER) {
      sock.pause();
      drainTimer = setInterval(() => {
        if (ws.bufferedAmount < LOW_WATER) {
          sock.resume();
          clearInterval(drainTimer!);
          drainTimer = null;
        }
      }, 20);
    }
  });

  ws.on("message", (data) => {
    if (Array.isArray(data)) data = Buffer.concat(data);
    sock.write(data as Buffer);
  });

  const cleanup = (why: string) => {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = null;
    sock.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, why);
  };

  sock.on("error", (err) => {
    log(`vnc upstream error: ${err.message}`);
    cleanup("vnc upstream error");
  });
  sock.on("close", () => cleanup("vnc upstream closed"));
  ws.on("close", () => cleanup("client closed"));
  ws.on("error", () => cleanup("client error"));
}
