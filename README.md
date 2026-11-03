# Remote-claude

本地端与远程 Claude 工作站的协作工具。远程端（Ubuntu 隔离虚拟机）里运行 Claude Code，本地端可以：

- 接入远程 Claude 的终端，断线后 Claude 继续工作，重连后画面完整恢复；
- 实时看到远程桌面，包括 Claude 正在操作的浏览器；
- 看到结构化的事件时间线：Claude 调用了什么工具、改了哪个文件、哪个文件同步完成；
- 通过 Syncthing 同步文件夹双向传文件，支持断点续传。

设计背景见 `docs/route-self-built.md`（自研路线）和 `docs/route-existing-tools.md`（现成工具路线）。

## 当前进度：M1（daemon、协议、命令行）+ M2（Electron GUI）+ 对话视图与拖拽传文件

| 部分 | 状态 |
|---|---|
| 配对与鉴权（Ed25519 设备密钥、一次性配对码、挑战应答、吊销） | ✅ 已完成，有测试 |
| 控制通道：心跳、指数退避重连、事件序号与断线补发 | ✅ 已完成，有测试 |
| 终端：每个连接对应一个 `tmux attach`，提前输入的按键会排队 | ✅ 已完成，有测试 |
| Claude Code hooks → 事件时间线 + Claude 状态推断 | ✅ 已完成，有测试 |
| Syncthing 事件 → 传输进度、`file.ready` | ✅ 已完成，用假 Syncthing 测试 |
| VNC 桥（WebSocket ↔ RFB），本地 VNC 代理 | ✅ 已完成，用假 VNC 服务端测试 |
| `rc` 命令行：pair / status / events / attach / vnc | ✅ 已完成，手动端到端验证 |
| Electron GUI：配对页、Claude 终端、远程画面（默认只看）、时间线、传输面板、设置 | ✅ 已完成，端到端测试（真实 Xvnc 画面） |
| 远程虚拟机部署脚本（`deploy/`） | ⚠️ 草稿，**没有在真实机器上跑过** |
| 对话视图（类似网页版）：从会话记录渲染气泡、Markdown、可折叠的工具调用 | ✅ 已完成，有测试 |
| 输入框发消息：空闲时粘贴进终端，忙/等权限时排队，空闲后自动送达 | ✅ 已完成，有测试 |
| 权限请求卡片：PermissionRequest hook → 界面“允许/拒绝”；无人回答时退回终端确认框 | ✅ 已完成，有测试 |
| 拖入文件 / 选择文件 / 粘贴截图 → inbox/ → 远程就绪后自动插入 `@路径` | ✅ 已完成，端到端测试 |
| 文件面板：outbox/ 与 inbox/，双击打开、拖出到桌面 | ✅ 已完成（拖出需真机验证） |
| 完整的接管锁（自动让 Claude 暂停） | ⏳ 之后 |
| GUI 安装包（三平台打包、签名） | ⏳ 之后 |

## 结构

```
packages/
  core/     两端共用：协议类型、Syncthing 事件监听、退避工具
  daemon/   远程端 rcd：HTTP/WebSocket 服务、鉴权、终端、hooks、VNC 桥
  client/   本地端：连接库（自动重连、补发）、rc 命令行、本地 VNC 代理
  gui/      本地端 Electron 应用
test/       集成测试（真实端口、真实 tmux）
deploy/     远程虚拟机部署草稿（Incus、systemd 用户服务）
```

三条通道，全部只经过 daemon 的一个端口（只绑定 Tailscale IP）：

| 通道 | 内容 | 鉴权 |
|---|---|---|
| `/ws` | 控制与事件（JSON） | 挑战应答：daemon 发随机数，客户端用设备私钥签名 |
| `/term` | 终端字节流 | 通过 `/ws` 申请的一次性令牌（60 秒有效，只能用一次） |
| `/vnc` | VNC 画面（noVNC 直连） | 同上 |

文件不走 daemon，由 Syncthing 在两端之间直接同步；daemon 只读取 Syncthing 的事件。

## 本地试用（不需要远程机器）

需要 Node.js 22+ 和 tmux。

```bash
npm install
npm test            # 31 个测试

# 起一个 daemon（终端里跑 bash 代替 claude）
mkdir -p /tmp/rcd-demo && cat > /tmp/rcd-demo/config.json <<'EOF'
{ "name": "demo", "listen": {"host":"127.0.0.1","port":18443}, "stateDir": "/tmp/rcd-demo/state",
  "hookPort": 18444, "terminal": {"command":"bash","cwd":"/tmp/rcd-demo"} }
EOF
npm run rcd -- --config /tmp/rcd-demo/config.json start &

npm run rcd -- --config /tmp/rcd-demo/config.json pair      # 打印配对码
npm run rc -- pair http://127.0.0.1:18443 <配对码>
npm run rc -- attach        # 接入终端；Ctrl-b d 断开，会话保留
npm run rc -- events        # 另开一个终端看时间线

# 模拟一次 Claude hook
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | node packages/daemon/hooks/forward-hook.mjs 18444
```

## GUI

```bash
npm run gui          # 构建并启动 Electron 应用
npm run test:gui     # 端到端测试（需要 Xvfb、Xvnc、tmux 和 Playwright）
```

界面分三块：
- 左边：**对话**（类似网页版）和**终端**两个标签。对话视图读的是同一个 Claude 会话，只是换一种显示方式；
  输入框发的消息由 daemon 用括号粘贴送进终端。终端每次连接都是远程 tmux 的一个 attach，断线自动重连。
- 右上：远程画面（noVNC，默认只看，勾选"我来操作"才发送键鼠）。
- 右下：时间线、传输进度、文件（outbox/ 与 inbox/）。

传文件：把文件拖进窗口、点"＋ 文件"、或在输入框粘贴截图 → 文件被复制进本地同步文件夹的 `inbox/`，
GUI 让本地 Syncthing 立刻扫描 → 远程收到并校验后，附件变为"已就绪"，发送时自动加上 `@远程路径`。
附件没传完就按发送，会变成"传完后自动发送"。

Claude 停下来等你确认时，顶栏闪烁、对话里出现权限卡片；窗口不在前台时还会发系统通知。
没人在 GUI 里回答时，约 2 分钟后交还给终端里的确认框。

对话视图和权限卡片依赖 Claude Code hooks：在远程执行 `rcd hooks-config`，把输出合并进 `~/.claude/settings.json`。

安全设计：
- 设备私钥只在主进程，用 Electron safeStorage（系统钥匙串）加密保存；界面进程拿不到私钥。
- 界面进程开启 `sandbox` + `contextIsolation`，只能调用 preload 暴露的几个方法；IPC 会校验调用方是自己的页面。
- 来自远程的文本（文件名、命令、提示词）一律用 `textContent` 插入；CSP 只允许本地脚本和 WebSocket 连接。
- 禁止页面跳转和新窗口，拒绝所有权限请求（摄像头、定位等）。

## 部署到远程（草稿）

1. 宿主机：`deploy/incus/create-vm.sh` 创建虚拟机（6 核、12 GB、150 GB）。
2. 虚拟机内：`deploy/vm/provision.sh` 安装 Xfce、TigerVNC、Chrome、Claude Code、Syncthing、Tailscale 和 systemd 用户服务，结尾会列出需要人工完成的步骤（Tailscale 登录、Claude `/login`、Playwright MCP、hooks 配置、配对）。
3. Syncthing 的 API Key 在其网页界面（设置 → 常规）里，复制到 `~/.config/rcd/syncthing-apikey`。
4. 本地：安装 Tailscale 和 Syncthing，把本地文件夹和远程 `~/workspace` 配对；然后 `rc pair`。

这些脚本没有实测过，请逐步执行并检查输出。

## 与调研文档相比的设计调整

| 调研文档 | 实际实现 | 原因 |
|---|---|---|
| 文件传输用 tus + HTTP Range | **Syncthing**，daemon 读它的事件 | 块级续传和校验、双向、Windows 原生支持，传输引擎不必自己写 |
| 画面用 KasmVNC | **TigerVNC 的 Xvnc**（标准 RFB），daemon 内置 WebSocket 桥 | 前端只认标准 VNC 协议，以后换 Windows 上的 VNC 服务端，前端不用改。代价是编码效率不如 KasmVNC，后续可再评估 |
| daemon 持有 claude 的 pty | Claude 跑在 **tmux** 里，每个终端连接是一个 `tmux attach` | 重连时 tmux 自动重绘完整画面；断线不影响 Claude；还能直接 SSH 进去 `tmux -L rcd attach` |
| HTTPS | 默认明文 HTTP，依赖 Tailscale（WireGuard）加密；可选配置 TLS 证书（如 `tailscale cert`） | 避免自签证书的分发和校验问题；应用层鉴权照常进行 |

## 已知限制

- `rc` 命令行的私钥以 0600 文件保存（`~/.config/remote-claude/identity.json`）；GUI 用系统钥匙串。两者是不同的设备身份，各自配对。
- Linux 上没有钥匙串服务（GNOME Keyring / KWallet）时，GUI 的私钥会退化为明文文件，设置页会提示。
- noVNC 固定在 1.4.0：1.5 以后的 npm 包含顶层 await，现有打包工具无法处理。TigerVNC 用不到 1.5 新增的 H.264。
- hooks 接收端口任何本机进程都能发事件（包括 Claude 自己），所以时间线是"参考信息"，不能当作安全审计依据。
- Claude 状态（空闲、忙碌、等待确认）是从 hooks 推断的，不是 Claude 直接报告的。
- 对话视图解析的是 Claude Code 的会话记录（`.jsonl`），这是内部格式，升级后可能需要调整解析；认不出的内容会被跳过，不会报错。
- 输入框发消息是"往终端里粘贴并回车"：只在 Claude 空闲（或没配置 hooks、状态未知）时直接送达。如果你同时在终端里输入了一半，两段文字会拼在一起。
- 权限请求等待 GUI 回答期间，终端里不会弹确认框；没人回答时约 2 分钟后才退回终端。
- 测试里 Syncthing 是模拟的，Claude 是用 bash 代替的；接真实 Claude Code 和 Syncthing 后需要再验证。
- 事件缓冲只在内存里：daemon 重启后，客户端会收到 reset，时间线从头开始。
