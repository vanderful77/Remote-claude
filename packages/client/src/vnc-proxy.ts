import { createServer, type Server } from "node:net";
import WebSocket from "ws";
import type { RemoteClient } from "./client";

/**
 * 本地 VNC 代理：在 127.0.0.1:<port> 开一个普通 TCP 端口，
 * 每个连进来的 VNC 查看器（TigerVNC Viewer、Remmina、macOS 屏幕共享……）
 * 都被转发到远程 daemon 的 /vnc（先通过控制通道申请一次性令牌）。
 *
 * 在 GUI 做好之前，这是"看远程画面"的最快方式；GUI 里则直接用 noVNC 连 /vnc，不需要它。
 */
export function startVncProxy(client: RemoteClient, port: number, log: (m: string) => void): Promise<Server> {
  const server = createServer(async (sock) => {
    sock.pause();
    let ws: WebSocket;
    try {
      ws = new WebSocket(await client.vncUrl(), ["binary"]);
    } catch (e) {
      log(`无法打开远程画面: ${(e as Error).message}`);
      sock.destroy();
      return;
    }
    ws.binaryType = "nodebuffer";
    ws.on("open", () => {
      sock.resume();
      log("VNC 查看器已连接");
    });
    sock.on("data", (d) => ws.readyState === WebSocket.OPEN && ws.send(d));
    ws.on("message", (d) => sock.write(d as Buffer));
    const close = () => {
      sock.destroy();
      ws.close();
    };
    sock.on("close", close);
    sock.on("error", close);
    ws.on("close", close);
    ws.on("error", (e) => {
      log(`远程画面连接错误: ${e.message}`);
      close();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
