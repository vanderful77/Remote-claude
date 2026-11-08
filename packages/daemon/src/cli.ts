#!/usr/bin/env -S npx tsx
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defaultConfigPath, loadConfig } from "./config";
import { DeviceStore, PAIRING_TTL_MS } from "./devices";
import { hooksSettings } from "./hooks";
import { Daemon } from "./server";

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks");

function usage(): never {
  console.log(`rcd - remote-claude daemon

用法:
  rcd start                启动 daemon
  rcd pair                 生成一次性配对码（${PAIRING_TTL_MS / 60000} 分钟有效）
  rcd devices              列出已配对设备
  rcd revoke <deviceId>    吊销设备（运行中的连接会在 15 秒内断开）
  rcd hooks-config         打印要合并进 ~/.claude/settings.json 的 hooks 配置

配置文件: --config <path>，或环境变量 RCD_CONFIG，默认 ${defaultConfigPath()}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const ci = args.indexOf("--config");
  const configPath = ci >= 0 ? args.splice(ci, 2)[1] : defaultConfigPath();
  const [cmd, ...rest] = args;
  if (!cmd) usage();
  const cfg = loadConfig(configPath);

  switch (cmd) {
    case "start": {
      const d = new Daemon(cfg);
      await d.start();
      const shutdown = async () => {
        await d.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "pair": {
      const code = new DeviceStore(cfg.stateDir).createPairingCode();
      console.log(`配对码: ${code}`);
      console.log(`在本地执行: rc pair <daemon 地址> ${code}`);
      return;
    }
    case "devices": {
      const list = new DeviceStore(cfg.stateDir).list();
      if (!list.length) console.log("（还没有配对设备）");
      for (const d of list) console.log(`${d.id}  ${d.name}  ${d.createdAt}`);
      return;
    }
    case "revoke": {
      if (!rest[0]) usage();
      console.log(new DeviceStore(cfg.stateDir).revoke(rest[0]) ? "已吊销" : "没有这个设备");
      return;
    }
    case "hooks-config":
      console.log(JSON.stringify(hooksSettings(HOOKS_DIR, cfg.hookPort), null, 2));
      return;
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
