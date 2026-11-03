#!/usr/bin/env -S npx tsx
import { hostname } from "node:os";
import { pair, RemoteClient } from "./client";
import { formatEvent } from "./format";
import { deviceIdFromKey } from "@rc/core";
import { loadOrCreateIdentity, loadProfile, saveProfile } from "./identity";
import { startVncProxy } from "./vnc-proxy";

function usage(): never {
  console.log(`rc - remote-claude 本地客户端

用法:
  rc pair <daemon 地址> <配对码> [--name 名字]   与远程 daemon 配对，例如 rc pair http://100.64.0.5:8443 ABCD-EFGH
  rc status                                     连接并显示状态
  rc events                                     实时显示事件时间线（断线自动重连并补发）
  rc attach                                     接入远程 Claude 终端（tmux：Ctrl-b d 断开，Claude 继续运行）
  rc send <文字>                                给 Claude 发一条消息（忙时排队，空闲后送达）
  rc vnc [--port 5901]                          在本机开 VNC 端口，用任意 VNC 查看器连 127.0.0.1:5901 看远程画面`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

function makeClient(): RemoteClient {
  const profile = loadProfile();
  if (!profile) {
    console.error("还没有配对。先在远程执行 rcd pair，再在本地执行 rc pair <地址> <配对码>");
    process.exit(1);
  }
  const id = loadOrCreateIdentity();
  const client = new RemoteClient({ url: profile.url, deviceId: profile.deviceId, privateKey: id.privateKey });
  client.on("fatal", (m) => {
    console.error(m);
    process.exit(2);
  });
  return client;
}

function status(msg: string) {
  process.stderr.write(`\x1b[2m[rc] ${msg}\x1b[0m\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  switch (cmd) {
    case "pair": {
      const name = flag(args, "--name") ?? hostname();
      const [url, code] = args;
      if (!url || !code) usage();
      const id = loadOrCreateIdentity();
      const r = await pair(url, code, name, id.publicKey);
      if (r.deviceId !== deviceIdFromKey(id.publicKey)) throw new Error("daemon 返回的设备 id 不一致");
      saveProfile({ url, deviceId: r.deviceId, daemonName: r.daemonName });
      console.log(`配对成功：本机设备 id ${r.deviceId}，远程 ${r.daemonName}`);
      return;
    }

    case "status": {
      const client = makeClient();
      client.once("connected", (info) => {
        console.log(`已连接 ${client.url}  设备名 ${info.deviceName}  Claude 状态 ${info.claudeState}`);
        client.stop();
      });
      client.on("disconnected", (d) => {
        if (d.retryInMs !== null) {
          console.error(`连接失败（${d.reason || d.code}）`);
          process.exit(1);
        }
      });
      client.start();
      return;
    }

    case "events": {
      const client = makeClient();
      client.on("connected", (i) => status(`已连接，Claude 状态: ${i.claudeState}`));
      client.on("disconnected", (d) => d.retryInMs !== null && status(`连接断开，${Math.round(d.retryInMs / 1000)} 秒后重连`));
      client.on("reset", () => status("daemon 重启过或断线太久，时间线从头开始"));
      client.on("event", (ev) => console.log(formatEvent(ev)));
      client.start();
      return;
    }

    case "attach": {
      if (!process.stdin.isTTY) {
        console.error("rc attach 需要在终端里运行");
        process.exit(1);
      }
      const client = makeClient();
      client.once("connected", async () => {
        const ws = await client.openTerminal(process.stdout.columns, process.stdout.rows);
        ws.binaryType = "nodebuffer";
        const restore = () => {
          process.stdin.setRawMode(false);
          process.stdin.pause();
        };
        ws.on("open", () => {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.on("data", (d) => ws.send(d, { binary: true }));
          process.stdout.on("resize", () =>
            ws.send(JSON.stringify({ type: "resize", cols: process.stdout.columns, rows: process.stdout.rows })),
          );
        });
        ws.on("message", (d, isBinary) => isBinary && process.stdout.write(d as Buffer));
        ws.on("close", (code, reason) => {
          restore();
          client.stop();
          status(`终端已断开（${reason.toString() || code}）。Claude 仍在远程 tmux 里运行，rc attach 可重新接入`);
          process.exit(0);
        });
        ws.on("error", (e) => status(`终端连接错误: ${e.message}`));
      });
      client.start();
      return;
    }

    case "send": {
      const text = args.join(" ");
      if (!text) usage();
      const client = makeClient();
      client.once("connected", async () => {
        const r = await client.sendChat(text);
        console.log(r.status === "sent" ? "已送达" : r.status === "queued" ? "Claude 正忙，已排队" : `被拒绝：${r.reason}`);
        client.stop();
      });
      client.start();
      return;
    }

    case "vnc": {
      const port = Number(flag(args, "--port") ?? 5901);
      const client = makeClient();
      client.on("connected", () => status("控制通道已连接"));
      client.on("disconnected", (d) => d.retryInMs !== null && status("控制通道断开，自动重连中"));
      client.start();
      await startVncProxy(client, port, status);
      status(`用 VNC 查看器连接 127.0.0.1:${port}`);
      return;
    }

    default:
      usage();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
