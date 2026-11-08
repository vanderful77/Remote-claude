import { afterEach, describe, expect, it } from "vitest";
import { connect, createServer, type Server } from "node:net";
import WebSocket from "ws";
import { startVncProxy } from "@rc/client";
import { once, pairedClient, startEnv, waitFor, type Env } from "./helpers";

/** 假的 VNC 服务端：先发 RFB 版本握手，之后原样回显 */
function fakeRfb(): Promise<Server> {
  const s = createServer((sock) => {
    sock.write("RFB 003.008\n");
    sock.on("data", (d) => sock.write(d));
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

let env: Env | null = null;
let rfb: Server | null = null;
let proxy: Server | null = null;
afterEach(async () => {
  proxy?.close();
  rfb?.close();
  await env?.cleanup();
  env = proxy = rfb = null;
});

describe("VNC 桥", () => {
  it("noVNC 方式：WebSocket(binary 子协议) 直通 RFB", async () => {
    rfb = await fakeRfb();
    env = await startEnv({ vnc: { host: "127.0.0.1", port: (rfb.address() as any).port } });
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");

    const ws = new WebSocket(await c.vncUrl(), ["binary"]);
    const chunks: Buffer[] = [];
    ws.on("message", (d) => chunks.push(d as Buffer));
    await once(ws, "open");
    expect(ws.protocol).toBe("binary");
    await waitFor(() => Buffer.concat(chunks).toString().startsWith("RFB 003.008"));
    ws.send(Buffer.from([1, 2, 3, 250]));
    await waitFor(() => Buffer.concat(chunks).subarray(12).equals(Buffer.from([1, 2, 3, 250])));
    ws.close();
    c.stop();
  });

  it("本地 VNC 代理：普通 TCP 查看器经由 rc vnc 连到远程", async () => {
    rfb = await fakeRfb();
    env = await startEnv({ vnc: { host: "127.0.0.1", port: (rfb.address() as any).port } });
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    proxy = await startVncProxy(c, 0, () => {});

    const viewer = connect((proxy.address() as any).port, "127.0.0.1");
    let got = "";
    viewer.on("data", (d) => (got += d.toString()));
    await waitFor(() => got.startsWith("RFB 003.008"));
    viewer.write("hello");
    await waitFor(() => got.endsWith("hello"));
    viewer.destroy();
    c.stop();
  });

  it("VNC 服务端没运行时，连接被干净地关闭", async () => {
    env = await startEnv({ vnc: { host: "127.0.0.1", port: 1 } });
    const c = await pairedClient(env);
    c.start();
    await once(c, "connected");
    const ws = new WebSocket(await c.vncUrl(), ["binary"]);
    ws.on("error", () => {});
    await once(ws, "close");
    c.stop();
  });
});
