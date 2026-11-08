// 用 esbuild 打包三份代码：
//   main.cjs     主进程（Node 环境，含 @rc/client、@rc/core、ws）
//   preload.cjs  preload（沙箱环境，只能 require electron）
//   renderer.js  界面（浏览器环境，含 xterm.js、noVNC）
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const require = createRequire(import.meta.url);
mkdirSync(out, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: "warning", target: "es2022" };

await Promise.all([
  build({
    ...common,
    entryPoints: [join(here, "src/main.ts")],
    outfile: join(out, "main.cjs"),
    platform: "node",
    format: "cjs",
    // ws 的可选原生加速模块，不装也能用
    external: ["electron", "bufferutil", "utf-8-validate"],
  }),
  build({
    ...common,
    entryPoints: [join(here, "src/preload.ts")],
    outfile: join(out, "preload.cjs"),
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: [join(here, "src/renderer/app.ts")],
    outfile: join(out, "renderer.js"),
    platform: "browser",
    format: "esm",
  }),
]);

copyFileSync(join(here, "src/renderer/index.html"), join(out, "index.html"));
copyFileSync(join(here, "src/renderer/styles.css"), join(out, "styles.css"));
copyFileSync(require.resolve("@xterm/xterm/css/xterm.css"), join(out, "xterm.css"));
console.log("gui built ->", out);
