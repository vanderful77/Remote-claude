#!/usr/bin/env node
// Claude Code hook 脚本：把 stdin 里的 hook JSON 转发给本机 daemon，然后立刻退出。
//
// 设计要点：
// - 永远 exit 0、不往 stdout 输出任何东西：这个脚本只"报告"，绝不影响 Claude 的决定。
// - 1.5 秒超时：daemon 没运行时也不会卡住 Claude。
// - 只用 Node 内置模块，Linux / Windows 通用（不依赖 curl 或 shell 语法）。
import http from "node:http";

const port = Number(process.argv[2] || process.env.RCD_HOOK_PORT || 8444);
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const body = Buffer.concat(chunks);
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/hook",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": body.length },
      timeout: 1500,
    },
    (res) => {
      res.resume();
      res.on("end", () => process.exit(0));
    },
  );
  req.on("timeout", () => req.destroy());
  req.on("error", () => process.exit(0));
  req.end(body);
});
setTimeout(() => process.exit(0), 3000).unref();
