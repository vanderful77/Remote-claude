#!/usr/bin/env node
// Claude Code 的 PermissionRequest hook：把权限请求交给 Remote Claude 界面回答。
//
// - daemon 在有 GUI 在线时会挂住这个请求，直到你在界面上点"允许"/"拒绝"，然后返回决定。
//   我们把决定原样打印到 stdout，Claude Code 据此放行或拒绝，终端里不再弹确认框。
// - 没有 GUI 在线、等太久没人回答、或 daemon 没运行：以退出码 2 结束且不输出决定。
//   按官方文档，这种情况"权限流程保持不变"，Claude Code 照常在终端里弹确认框。
import http from "node:http";

const port = Number(process.argv[2] || process.env.RCD_HOOK_PORT || 8444);
const fallback = () => process.exit(2);
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const body = Buffer.concat(chunks);
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/permission",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": body.length },
      timeout: 115_000,
    },
    (res) => {
      const out = [];
      res.on("data", (c) => out.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return fallback();
        const text = Buffer.concat(out).toString("utf8");
        try {
          JSON.parse(text);
        } catch {
          return fallback();
        }
        process.stdout.write(text, () => process.exit(0));
      });
    },
  );
  req.on("timeout", () => req.destroy());
  req.on("error", fallback);
  req.end(body);
});
