# 自研路线：研究与设计

> 适用场景：本地端（任意操作系统）跨公网连接远程 Ubuntu 24.04.4 LTS 上的隔离环境。远程环境里由 Claude Code 读写文件、操作浏览器，本地端提供可视化的双向文件传输（几百 MB 到 1 GB，支持断点续传），并能实时看到浏览器画面。必须使用订阅额度。
>
> 本文只讨论"自研路线"。"现成工具路线"（RustDesk、Syncthing 等拼装方案）另有文档，这里只在第 7 节做简短对比。
>
> 调研日期：2026-11-03。涉及 Anthropic 条款和计费的内容变化很快，第 2 节标出了每条结论的出处和可信度。

---

## 0. 一页结论

1. **自研的价值在"整合"，不在"重造轮子"。** 值得自己写的只有三样：把文件、Claude、画面串起来的**本地 GUI**；负责调度的**远程 daemon**；带续传和校验的**文件传输引擎**（基于现成协议）。网络层（Tailscale）、智能体（Claude Code 本身）、浏览器自动化（Playwright MCP）、远程画面（KasmVNC/noVNC）一律用现成的。
2. **订阅额度下，最稳妥的驱动方式是"在伪终端（pty）里跑原版交互式 Claude Code"。** 结构化事件通过 Claude Code 的 hooks 和会话记录文件拿。Agent SDK 和 `claude -p` 能用订阅登录，官方条款也把"个人使用 Agent SDK"写进了订阅额度的适用范围，但这两种方式的计费口径在 2026 年有过变动（详见 2.1 节），所以只作为可切换的第二种驱动。
3. **连接方向不必对称。** 永远由本地主动连远程：上传走 tus 协议，下载走 HTTP Range 请求。"远程发文件给本地"的实现方式是：远程先发一个通知，本地再去拉取。这样本地完全不需要对外开放端口。
4. **远程 daemon 放在隔离边界里面**（容器或虚拟机内部），和 Claude、Chrome、虚拟显示器在一起。对外只暴露一个端口，并且只绑定在 Tailscale 的虚拟内网地址上。CDP、VNC 等端口全部只监听本机回环地址。
5. **实时画面的 MVP 用 KasmVNC/noVNC 嵌入。** 它能看到整个桌面，包括浏览器以外的应用。CDP screencast 作为"只看浏览器"的轻量补充。WebRTC 推流留到后期，确实需要省带宽、降延迟时再做。
6. **技术选型**：TypeScript 全栈，本地 GUI 用 Electron。理由是 Electron 自带 Chromium，WebRTC、xterm.js、noVNC 在三个系统上表现完全一致。另外 node-pty、Playwright、Agent SDK 都把 Node 当作一等公民支持。
7. **工作量**：一位有经验的开发者大约 4～7 周能做出 MVP，边学边做大约翻倍。最大的风险是 Claude Code 的条款、计费、界面和 hooks 格式变化，以及自己写的鉴权代码出安全漏洞。

---

## 1. 全局图景：自研什么，不自研什么

### 1.1 判断原则

可以把整个系统想成一条**装配线**：传送带（网络）、工人（Claude）、工具（浏览器自动化）、监控（画面）、调度台（GUI 和 daemon）。自研的意义在于**你要的那张调度台在市面上不存在**，而不是你能造出更好的传送带。

所以每一层都问两个问题：

- 现成组件能满足需求的 90% 吗？
- 这一层出 bug 的代价有多高？代价越高，越应该交给经过大规模验证的组件。

**这个比方在哪里不成立**：装配线的各个环节是解耦的，而这里各层之间有安全上的耦合。比如网络层选 Tailscale，就意味着你的鉴权模型、端口绑定方式都要围绕它来设计。所以"用现成的"不等于"不用理解它"。

### 1.2 逐层决策

| 层 | 决策 | 理由 |
|---|---|---|
| 网络连通和加密 | **保留 Tailscale（或自建 Headscale 控制端）** | 跨公网穿透 NAT、密钥分发、加密（WireGuard）都是极容易出错又不产生差异化价值的部分。自己实现 STUN/TURN 加鉴权，工作量至少几周，而且安全上很难做到同等水平。代价是依赖第三方控制面，用 Headscale 自建可以消除这一点。 |
| 智能体 harness | **不造，驱动原版 Claude Code 二进制** | 硬性需求就是 Claude 的 harness。条款还要求"Claude Code 二进制不得修改"（见 2.1 节）。你能做的只是在外面包一层。 |
| 浏览器自动化 | **用 Playwright MCP**，通过 CDP 连接到 daemon 启动的 Chrome | 成熟、读的是网页的结构化信息（无障碍树）而不是像素，比截图点击稳定得多 |
| 远程画面 | **MVP 嵌入 KasmVNC/noVNC**，后期可选 WebRTC | 见 3.5 节 |
| 文件传输 | **协议用现成的（tus 上传、HTTP Range 下载），引擎和界面自研** | 协议层有标准和成熟的库，可视化队列、和 Claude 的联动是你的差异化部分 |
| 本地 GUI | **自研**（这是整个项目的核心价值） | 文件面板、Claude 时间线、实时画面、"交给 Claude 处理"按钮，市面上没有现成的组合 |
| 远程 daemon | **自研** | 负责调度：管理 pty 里的 Claude、收集事件、做文件服务、给 VNC 做反向代理、做应用层鉴权 |

### 1.3 修正上一轮"两端跑同一个 daemon"的说法

之前建议两端跑同一个 daemon，这样代码只写一份。细想之后有个更好的做法：**语义上对称，连接方向上不对称。**

- 只有远程 daemon 监听端口，本地端永远是发起连接的客户端。
- "本地 → 远程"：本地通过 tus 协议上传。
- "远程 → 本地"：远程在控制通道里发一条通知（"outbox 里有新文件 x，大小、哈希是多少"），本地收到后用 HTTP Range 请求拉取。如果设置了自动接收，用户看到的效果就是"远程推过来了一个文件"。

好处：

1. 本地机器不监听任何端口，攻击面小一半。
2. 本地在咖啡馆、公司网络等奇怪的环境里也能工作，哪怕没装 Tailscale，只要能连到远程就行。
3. 两个方向的续传都由客户端发起，状态机只需要写一个。

---

## 2. 订阅额度约束下怎么驱动 Claude

### 2.1 先把条款核实清楚

以下内容来自 2026-11-03 抓取的 Claude Code 官方文档原文，以及第三方报道（已逐条标注）。

**官方文档明确写着的：**

1. **OAuth（订阅登录）的定位**：OAuth 认证"专供订阅计划的购买者，用于支持对 Claude Code 及其他 Anthropic 原生应用的普通使用"。开发者"构建与 Claude 能力交互的产品或服务，包括使用 Agent SDK 构建的"，应该使用 API Key。Anthropic 不允许第三方开发者在自己的应用里提供 Claude.ai 登录，也不允许**代表其用户**通过 Free/Pro/Max/Ultra 凭据转发请求，更不允许收集、存储或中转 Claude.ai 的凭据或会话令牌。（[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)）
2. **个人使用的边界**：同一页写着，上述限制"不妨碍终端用户用自己的 Claude 订阅登录**未修改的** Claude Code 二进制，包括由某个平台托管 Claude Code 的情形"。还写着："Pro、Max、Ultra 计划公布的用量上限，是按**普通的、个人的** Claude Code 和 Agent SDK 使用来设定的。"（[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)）
3. **Agent SDK 概览页**："除非事先获得批准，Anthropic 不允许第三方开发者为其产品（包括基于 Agent SDK 构建的智能体）提供 claude.ai 登录或其用量额度。"（[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)）
4. **长期令牌**：`claude setup-token` 生成的 `CLAUDE_CODE_OAUTH_TOKEN` 走订阅额度，但"只能发起模型请求"，不能建立 Remote Control 会话。`--bare` 模式不读取这个令牌，只认 API Key。（[Authentication](https://code.claude.com/docs/en/authentication)、[Headless](https://code.claude.com/docs/en/headless)）
5. **无头模式**：`claude -p` 默认会使用订阅登录（不加 `--bare` 时）。它支持 `--output-format stream-json`、`--input-format stream-json`（通过标准输入持续喂入多轮消息）、`--include-partial-messages`（逐 token 输出），以及 `--resume <session_id>`。权限方面：较新版本（v2.1.302+）的 `-p` 默认是 Manual 模式，需要审批的工具调用会被拒绝，除非有 `PermissionRequest` hook 或 `--permission-prompt-tool` 来回答。（[Headless](https://code.claude.com/docs/en/headless)）

**第三方报道、尚未在官方页面核实的：**

6. **Agent SDK 独立额度**：多篇文章称，Anthropic 在 2026 年 5 月宣布，从 6 月 15 日起，Agent SDK 和 `claude -p` 的用量**不再计入交互式订阅额度**，改为每月单独的 "Agent SDK credit"（Pro 20 美元、Max 5x 100 美元、Max 20x 200 美元）。另有一篇文章称这项变更**已经暂停**。我在 2026-11-03 抓取的官方 [Costs](https://code.claude.com/docs/en/costs) 页面里没有找到 "Agent SDK credit" 的说法，但这不能证明变更没有发生。（[claudefa.st](https://claudefa.st/blog/guide/development/agent-sdk-credit)、[DEV: What Anthropic's $200 Agent SDK Credit Means](https://dev.to/vainamoinen/what-anthropics-200-agent-sdk-credit-means-if-you-run-claude-p-in-production-ce2)、[digitalapplied: pauses the June 15 change](https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026)、[MagnaCapax gist](https://gist.github.com/MagnaCapax/d9177e35b355853f03c730dfcaa693ef)）
7. 2026 年 2 月，有报道称 Anthropic 更新文档，明确禁止第三方应用使用订阅 OAuth。（[WinBuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)）

**对本项目的解读**（这是我的推断，不是官方答复）：

- 你在**自己的**服务器上，用**自己的**订阅，登录**未修改的** Claude Code，供**自己**使用。这落在条款明确允许的范围内（第 2 条）。
- 你写的 daemon 只是在 pty 或子进程里启动官方二进制，不碰、不存、不转发你的 OAuth 令牌。登录在容器里通过官方 `/login` 流程完成，凭据只留在远程环境里。这样就避开了"收集、存储、中转凭据"那一条。
- **红线**：一旦把这个软件分发给别人，让别人"用你的账号"，或者软件内置 claude.ai 登录入口，就越界了。如果要分发，必须让每个用户在官方流程里登录自己的订阅，或者使用自己的 API Key。
- **不确定点**：如果第 6 条的独立额度确实生效了，用 `claude -p` 或 Agent SDK 驱动的用量就走那份每月 20～200 美元的额度，而不是交互式额度。对重度使用者来说，差别可能非常大。**这是把"pty 里跑交互式会话"选为主方案的主要原因。**开工前请到 claude.ai 的 Settings → Usage 和 Help Center 确认当前口径。

### 2.2 四种驱动方式对比

| 方式 | 原理 | 能拿到结构化事件吗 | 计费口径 | 优点 | 缺点 |
|---|---|---|---|---|---|
| **A. pty 里跑交互式 `claude`**（推荐主方案） | daemon 用 node-pty 启动 `claude`，终端字节流通过 WebSocket 推到本地，由 xterm.js 显示；本地的键盘输入回写到 pty | 不能直接拿到；需要 hooks 加会话记录补充（见 2.3 节） | 交互式使用，口径最明确 | 和你亲手在终端里用完全一样，所有功能（斜杠命令、权限确认、`/login`）都可用；条款风险最低 | 界面是终端字符画，不是结构化数据；做"自动化流水线"不方便 |
| B. `claude -p --input-format stream-json --output-format stream-json` | daemon 起一个长期运行的子进程，通过 stdin/stdout 交换 JSON 行 | **能**，每条消息、每次工具调用都是结构化事件 | 可能走 Agent SDK 独立额度（见 2.1 第 6 条） | 很适合做"传完文件 → 自动交给 Claude → 完成后回传"的流水线 | 权限确认要自己实现（`--permission-prompt-tool` 或 hook）；交互式命令不全 |
| C. Agent SDK（TypeScript） | 库，底层同样启动 Claude Code 二进制 | **能**，类型最完整，有 `canUseTool` 回调 | 同 B | 编程体验最好；权限回调可以直接映射成 GUI 弹窗 | 同 B；版本跟进成本高 |
| D. 官方 Remote Control | `claude --remote-control`，从 claude.ai/code 或手机 App 操作 | 不能（是官方界面） | 交互式 | 零开发；能和 A 叠加使用，在 pty 里启动时加上这个参数，手机也能看 | 不能嵌进你的 GUI；`CLAUDE_CODE_OAUTH_TOKEN` 不支持 Remote Control，必须用 `/login` 登录 |

**推荐做法**：daemon 里定义一个 `ClaudeDriver` 抽象接口，实现两个驱动：

- **`PtyDriver`（默认）**：方式 A，启动参数加 `--remote-control`，免费获得手机端访问。
- **`StreamJsonDriver`（可选）**：方式 B，留给"批处理流水线"类任务。等确认计费口径后再决定要不要默认开启。

GUI 只依赖事件模型（见 3.3 节），不关心底层用的是哪个驱动。

### 2.3 在 pty 方案下拿到结构化事件

pty 里的终端画面只适合人看。要让 GUI 知道"Claude 刚刚修改了 `report.xlsx`"，有两条可以叠加的来源：

1. **Hooks**：在远程环境的 `~/.claude/settings.json` 里配置 `PreToolUse`、`PostToolUse`、`Stop`、`Notification` 等钩子，钩子脚本把收到的 JSON 用 `curl` POST 到 daemon 的本机接口（`127.0.0.1`）。daemon 由此知道每一次工具调用、编辑了哪个文件、什么时候在等用户确认。
   **坑**：hook 是同步执行的，慢的 hook 会拖慢 Claude。脚本只做"POST 一下就退出"，并设置超时。
2. **会话记录文件**：Claude Code 把每个会话写成 `~/.claude/projects/<目录名>/<session>.jsonl`。daemon 可以持续读取它的新增内容，补全对话文本。
   **不确定点**：这是内部格式，官方没有承诺稳定。解析代码要写得宽容，遇到不认识的字段就跳过。

**比方**：pty 是"看工人干活的监控画面"，hooks 是"工人每做一步就在工单上盖个章"。GUI 用工单（hooks）做联动，用画面（pty）给人看。

---

## 3. 架构

### 3.1 组件图

```
本地端（Electron 应用，Win/macOS/Linux）                远程端隔离环境（容器或 VM，Ubuntu）
┌──────────────────────────────────────┐            ┌─────────────────────────────────────────────┐
│ 渲染进程（React）                      │            │ remote-daemon（Node/TS）                       │
│  ├ 文件双栏 + 传输队列                  │            │  ├ HTTPS :8443（只绑定 tailnet IP）            │
│  ├ Claude 终端（xterm.js）            │  WSS 控制   │  │   ├ /ws      控制与事件（JSON）              │
│  ├ 事件时间线（工具调用、改动的文件）     │◀──────────▶│  │   ├ /files   tus 上传、Range 下载          │
│  └ 实时画面（noVNC 客户端 / screencast）│  HTTPS 文件 │  │   ├ /vnc     反向代理到 127.0.0.1:6901      │
│ 主进程（Node）                         │◀──────────▶│  │   └ /hook    只接受 127.0.0.1（hooks 回调）  │
│  ├ 传输引擎（续传、哈希、限速）          │  WSS 画面   │  ├ PtyDriver ── node-pty ── claude (交互)       │
│  ├ 设备密钥（Ed25519，存系统钥匙串）     │◀──────────▶│  ├ StreamJsonDriver（可选）                    │
│  └ 本地落盘（路径净化、原子改名）        │            │  └ 浏览器管理：启动 Chrome，可选 CDP screencast   │
└──────────────────────────────────────┘            │ Xvfb + Xfce + KasmVNC(127.0.0.1:6901)          │
                 ▲                                   │ Chrome --remote-debugging-port=9222 (127.0.0.1) │
                 │  Tailscale（WireGuard 加密 + ACL）   │   ▲                                          │
                 └───────────────────────────────────│   └── Playwright MCP --cdp-endpoint ← claude  │
                                                     │ /workspace/{inbox,outbox,work}（数据卷）         │
                                                     └─────────────────────────────────────────────┘
```

### 3.2 语言选型：TypeScript 全栈

| 候选 | 优点 | 缺点 |
|---|---|---|
| **TypeScript（推荐）** | node-pty、Playwright（CDP screencast）、Agent SDK、tus 的服务端和客户端库，全部是 Node 的一等公民；Electron 主进程也是 Node，**传输引擎、协议类型定义、事件模型三端共用一套代码** | 单个进程的并发和 CPU 性能不如 Go，计算哈希要放到 worker 线程里 |
| Go | 远程 daemon 能编译成单文件，网络和加密库好，tusd 本身就是 Go 写的 | 没有官方 Agent SDK；本地 GUI 还是要用 Web 技术，变成两种语言 |
| Rust | 性能和安全性最好，可以配合 Tauri | 学习曲线陡，迭代慢，不适合"先验证需求"的阶段 |

1 GB 文件计算 BLAKE3 或 SHA-256 的耗时：Node 原生的 `crypto` 模块算 SHA-256，在有 SHA 硬件指令的 CPU 上通常能达到每秒 1 GB 以上（数量级估计），所以单线程也够用。真正的瓶颈是网络。

### 3.3 通道设计：为什么要拆成三条

| 通道 | 内容 | 特点 |
|---|---|---|
| 控制和事件（WSS `/ws`） | 指令（开始任务、暂停、接管）、事件（工具调用、传输进度、新文件就绪）、pty 字节流 | 数据小、频繁、对延迟敏感 |
| 文件（HTTPS `/files`） | tus 上传块、Range 下载 | 数据大、可以重试、追求吞吐 |
| 画面（WSS `/vnc` 或 WebRTC） | 画面帧 | 持续占用带宽，丢掉旧帧也无所谓 |

**为什么不能混在一条 WebSocket 里**：TCP 是严格按顺序交付的。假设你把一个 8 MB 的数据块写进一条 WebSocket，上行带宽 20 Mbps，这块要传 3.2 秒。在这 3.2 秒里，排在它后面的"暂停 Claude"指令只能等着。这叫**队头阻塞**（head-of-line blocking）。拆成多个连接以后，每条连接各自排队，指令不会被大文件堵住。（HTTP/2 的多路复用缓解了应用层的问题，但底层 TCP 丢包时仍然会互相影响；QUIC/HTTP3 才能彻底解决，MVP 阶段不必追求。）

**事件模型**（三端共用的类型定义，节选）：

```ts
type Event =
  | { t: "claude.tool"; phase: "pre" | "post"; tool: string; input: unknown; ts: number }
  | { t: "claude.awaiting_permission"; detail: string }
  | { t: "claude.turn_end"; sessionId: string }
  | { t: "file.ready"; dir: "outbox"; path: string; size: number; sha256: string }
  | { t: "xfer.progress"; id: string; bytes: number; total: number }
  | { t: "control.lock"; holder: "claude" | "human" };
```

### 3.4 文件传输引擎

**上传（本地 → 远程）用 tus 协议。** tus 是一个开放的可续传上传标准，参考实现 tusd 用 Go 编写，Node 端有 `@tus/server`，浏览器和 Node 客户端有 `tus-js-client`。流程如下：

1. `POST /files`，带上 `Upload-Length: 1073741824` 和元数据（文件名、目标目录、客户端算好的 sha256）。服务端返回 `Location: /files/abc123`。
2. `PATCH /files/abc123`，带上 `Upload-Offset: 0`，持续流式发送数据。
3. 如果断线了：`HEAD /files/abc123`，服务端回复 `Upload-Offset: 751619276`，客户端从这个偏移量继续发送 `PATCH`。

**用具体数字走一遍：**

- 文件 1 GB（1,073,741,824 字节），本地上行 20 Mbps，约等于每秒 2.5 MB，全程约 430 秒（7 分钟多）。
- 传到第 300 秒时 Wi-Fi 断了。此时服务端已经落盘约 750 MB。
- 重连后，`HEAD` 返回偏移量 751,619,276，客户端从这里继续，再传约 130 秒就完成。如果没有续传，就要从头再来，又是 7 分钟。
- 全部传完后，服务端对完整文件计算 sha256，和元数据里客户端给的值比对。一致就把文件**原子改名**，从 `.partial/abc123` 改到 `/workspace/inbox/报告.xlsx`，然后发出 `file.ready` 事件。不一致就删除临时文件并报错。

**下载（远程 → 本地）用 HTTP Range 请求：**

- 本地发 `GET /files/out/<id>`，带上 `Range: bytes=751619276-`，服务端返回 `206 Partial Content`。
- 本地先写入 `xxx.part`，传完校验 sha256，再改名为正式文件名。

**哈希放在哪里算**：边读边算（流式）。客户端在读取文件、准备上传的同时计算哈希，不需要额外再读一遍。但第一次请求要在元数据里带上哈希值，而这时哈希还没算完。两种办法：先完整计算一遍（1 GB 用时约 1～2 秒，可以接受），或者把哈希放在上传结束后的确认请求里发送。MVP 选前者，逻辑最简单。

**背压**：

- 读取文件用流（`fs.createReadStream`），写入用流，用 `pipeline()` 连接起来，这样当网络发送缓冲区满了，读取会自动暂停，内存占用保持恒定。
- **反例**：如果用 `readFile` 把整个 1 GB 文件读进内存再发，Electron 进程的内存会直接涨 1 GB 以上。同时传 3 个文件就可能崩溃。
- 同时进行的传输任务数要限制，比如最多 2～3 个，其余排队。

**路径穿越和文件名净化**（接收端两边都要做，因为远程 Claude 生成的文件名同样不可信）：

- 拒绝绝对路径和包含 `..` 的路径。拼接之后用 `realpath` 解析，确认结果仍然以目标根目录开头。
- **符号链接**：Claude 可以在 outbox 里创建一个指向 `/etc` 或 `~/.claude` 的符号链接。下载服务提供文件前要先 `lstat` 检查，拒绝符号链接，或者先解析再判断是否越界。
- Windows 保留名（`CON`、`PRN`、`NUL`、`COM1` 等）、结尾的点和空格、`\ / : * ? " < > |` 这些字符要处理。macOS 的 Unicode 规范化（NFD 和 NFC）可能让"看起来同名"的两个文件实际上不同，统一转成 NFC。
- 同名冲突：自动重命名成 `文件 (1).ext`，不要静默覆盖。
- 磁盘空间：创建上传之前检查 `Upload-Length` 和剩余空间，空间不够直接拒绝，不要写到一半才发现磁盘满了。

**可视化**（GUI）：

- 传输队列：每项显示文件名、方向、进度条、速度（用指数移动平均平滑，否则数字会剧烈跳动）、预计剩余时间，以及暂停、继续、取消按钮。
- 支持拖拽上传。
- 两栏文件浏览器（本地和远程 workspace），远程文件右键可以"交给 Claude 处理"，实际上就是把一段带 `@path` 的提示词发送到 pty 或 stream-json 驱动。

### 3.5 实时画面：三种方案对比

| 方案 | 能看到什么 | 带宽和延迟 | 实现难度 | 结论 |
|---|---|---|---|---|
| **KasmVNC / noVNC 嵌入** | **整个桌面**：浏览器（包括地址栏、弹窗、下载提示）、终端、其他应用 | VNC 编码，按画面变化传输；KasmVNC 支持 WebP/JPEG 和动态质量调整。典型办公画面每秒几百 Kbps 到几 Mbps（经验估计，取决于画面变化量） | **低**：容器里跑 KasmVNC，daemon 做 WebSocket 反向代理，GUI 嵌入 noVNC 客户端或 KasmVNC 的网页客户端 | **MVP 首选**，因为"其他应用"也需要看整个桌面 |
| **CDP screencast**（`Page.startScreencast`，或 Playwright 1.59 新增的 `page.screencast` API） | **只有当前标签页的网页内容**，看不到浏览器界面和其他应用 | 逐帧 JPEG；按 1280×800、质量 50～60 估算，每帧几十 KB，10 fps 时约几 Mbps；页面不变就不发帧 | **低到中**：daemon 通过 CDP 连到同一个 Chrome，把帧通过 WebSocket 转发 | 适合做一个"只看浏览器"的小窗口，或者手机上省流量看。只支持 Chromium 系浏览器 |
| **WebRTC 推流**（Selkies/GStreamer，或 pion + ffmpeg x264 采集 X 显示） | 整个桌面 | H.264 硬件或软件编码，1080p 约 1～3 Mbps，延迟最低 | **高**：信令、编码器、码率控制、音频，还有各系统 WebView 的兼容性 | 后期优化项。Tailscale 内网直连时一般不需要 TURN |

**两个容易忽略的点：**

1. **你和 Claude 看到的是同一个 Chrome，但"感知方式"不同。** 你看的是像素，Claude 通过 Playwright MCP 读的是网页结构。如果你在 Claude 操作时插手点了一下，它记着的页面状态就过时了。所以 GUI 要有一个**"接管锁"**：点击"我来操作"时，daemon 先向 pty 发送 Esc 中断 Claude 当前这一轮（或者在 stream-json 模式下发送 interrupt），然后把锁状态切成 `human`，VNC 的输入通道这时才打开。交还控制权时提示 Claude"页面可能已经变化，先重新获取快照"。
2. **Chrome 由 daemon 启动，Playwright MCP 用 `--cdp-endpoint` 连接上去**，而不是让 MCP 自己启动一个浏览器。这样浏览器开在 Xvfb 的显示器上，VNC 能看到它；用户数据目录固定，网站登录状态能保留；daemon 也能对同一个浏览器做 screencast。
   - 注意 1：较新版本的 Chrome 要求开启远程调试端口时必须指定**非默认**的 `--user-data-dir`（出于安全考虑的改动，具体从哪个版本开始请以 Chrome 发布说明为准）。
   - 注意 2：**CDP 端口等于浏览器的完全控制权**，包括读取所有 Cookie。它只能绑定 `127.0.0.1`，绝不能对外暴露。

### 3.6 本地 GUI 技术选型：推荐 Electron

| 候选 | 关键差异 |
|---|---|
| **Electron（推荐）** | 自带 Chromium，**WebRTC、WebCodecs、xterm.js、noVNC 在 Windows、macOS、Linux 上行为一致**。这对"本地操作系统不应影响体验"这条要求最关键。主进程是 Node，可以直接复用传输引擎。代价是安装包 100 MB 以上，内存占用较高。 |
| Tauri | 安装包只有几 MB。但它用的是系统自带的 WebView：Windows 是 WebView2（Chromium 内核），macOS 是 WKWebView（Safari 内核），Linux 是 WebKitGTK，**三种内核**。WebKitGTK 对 WebRTC 的支持长期不完整，以后上 WebRTC 画面会出跨平台差异。后端还要写 Rust。 |
| 纯 Web（本地 daemon 起一个 localhost 页面，用浏览器打开） | 最轻，作为**后备入口**很好：同一套前端代码，没装客户端的机器打开浏览器也能用。但大文件的流式落盘、系统钥匙串、托盘图标等能力受浏览器限制。 |

**Electron 的安全配置是必须项**：GUI 会渲染 Claude 的输出和网页标题等不可信内容。要开启 `contextIsolation: true`、`sandbox: true`，设置 `nodeIntegration: false`，用 preload 脚本暴露最小化的 API，配置严格的 CSP，渲染 Markdown 时做净化。Electron 应用里一个 XSS 漏洞可能直接升级成本地代码执行。

---

## 4. 隔离方案如何和自研 daemon 结合

### 4.1 daemon 放在隔离边界里面

**结论：远程 daemon 和 Claude、Chrome、Xvfb、KasmVNC 放在同一个隔离单元内（容器或虚拟机）。**

如果把 daemon 放在宿主机上，它就得跨越边界去：

- 读写容器里的 workspace（挂载卷还可以接受）；
- 启动容器里的 `claude`（需要 `docker exec`，也就是要访问 `docker.sock`，**等于拿到宿主机 root**）；
- 连接容器里的 CDP 和 VNC（需要把这些端口映射出来）。

这样一来，一个面向公网（哪怕只是 tailnet）的服务就拿到了宿主机的 root 权限，隔离形同虚设。放在里面的话，daemon 被攻破，最坏也只是"这个工作站沦陷"，宿主机和 SSH 上的其他任务不受影响。

**比方**：daemon 是工作室的"前台"。前台应该坐在工作室里，而不是坐在整栋楼的总控室。

### 4.2 端口暴露

| 端口 | 绑定地址 | 说明 |
|---|---|---|
| daemon HTTPS 8443 | **只绑定 Tailscale IP**（100.x.y.z） | 唯一对外的入口，承载 `/ws`、`/files`、`/vnc` |
| KasmVNC 6901 | 127.0.0.1 | 由 daemon 做鉴权后反向代理 |
| Chrome CDP 9222 | 127.0.0.1 | 只给 Playwright MCP 和 daemon 用 |
| daemon `/hook` | 127.0.0.1 | 只接收 hooks 的回调 |
| SSH（宿主机） | 和本项目无关 | 宿主机原有配置不变 |

**Tailscale 放在哪里**：推荐放进隔离单元里。有两种做法：

- Docker 方案：用 Tailscale **sidecar 容器**，和工作站容器共享网络命名空间（`network_mode: service:tailscale`）；或者在容器内用 `tailscaled --tun=userspace-networking` 运行。
- 虚拟机或 Incus 系统容器方案：直接在里面装 Tailscale。

这样做的效果：

- 工作站在 tailnet 里是一台**独立节点**，可以单独设置 ACL（比如"只有我的笔记本能访问工作站的 8443 端口"）。
- 宿主机的网络和 SSH 不受影响。
- 如果把 Tailscale 装在宿主机上再做端口映射，Docker 端口映射会绕过 ufw 的老问题又会出现，而且映射时容易手滑写成 `0.0.0.0`。

### 4.3 有没有 `/dev/kvm` 时的差别

| | 有 KVM：Incus/LXD 虚拟机 | 没有 KVM：rootless Docker / Podman 或 Incus 系统容器 |
|---|---|---|
| 隔离强度 | 独立内核，强 | 共享内核，中 |
| daemon、Claude、Chrome 的部署 | 和普通 Ubuntu 一样，用 systemd 管理 | Docker：一个容器里用 supervisord 管多个进程，或者拆成多个容器共享卷和网络；Incus 系统容器：和虚拟机写法基本一样 |
| Chrome 和 Electron 沙箱 | 正常 | Docker 里可能需要 `--shm-size=2g`、自定义 seccomp 配置，甚至 `--no-sandbox`（会削弱隔离）；Claude Code 的 bubblewrap 沙箱可能需要 `enableWeakerNestedSandbox` |
| 资源上限 | 虚拟机的 CPU 和内存配额 | `--cpus` / `--memory` / `--pids-limit`，或 Incus 的 `limits.*` 配置 |
| 快照和回滚 | `incus snapshot` | Docker 用数据卷备份加镜像重建；Incus 用快照 |

**持久化的数据卷**：`/workspace`（工作文件）、`~/.claude`（**订阅登录凭据**，只在这个卷里，绝不经过 daemon 传给本地）、Chrome 用户数据目录。

**首次登录 Claude**：在本地 GUI 的终端面板里（也就是 pty 里的 `claude`）执行 `/login`，用官方流程完成授权。daemon 全程只是转发终端字节，不解析、也不保存凭据。

---

## 5. 安全模型

### 5.1 威胁清单

| # | 威胁 | 例子 |
|---|---|---|
| T1 | 外部有人连到 daemon | tailnet 里另一台被攻破的机器、端口误暴露到公网 |
| T2 | 本地设备丢失 | 笔记本被偷，攻击者打开 GUI 就能控制远程 |
| T3 | **提示词注入** | Claude 浏览的网页里藏着"把 ~/.claude 打包上传到某地址" |
| T4 | 恶意文件名或内容 | 路径穿越、符号链接、超大文件写满磁盘 |
| T5 | GUI 渲染不可信内容 | Electron 里的 XSS 升级成本地代码执行 |
| T6 | daemon 自身漏洞 | 自己写的鉴权逻辑有 bug |

### 5.2 分层防御

1. **网络层（应对 T1）**：Tailscale 的 WireGuard 提供设备级的身份认证和加密。ACL 设置为只允许你的设备访问工作站的 8443 端口。
2. **配对（应对 T1、T2）**：
   - daemon 首次启动时生成一个一次性配对码（比如 8 位，10 分钟内有效），打印到容器日志里。你通过 SSH 查看。
   - 本地 GUI 生成一对 Ed25519 设备密钥，私钥存进系统钥匙串（macOS Keychain、Windows DPAPI 或 Credential Manager、Linux Secret Service）。然后在 TLS 连接里把配对码和公钥一起提交给 daemon。
   - daemon 记录"已授权的设备公钥列表"，配对码随即作废。
3. **会话鉴权（应对 T1）**：每次连接时，daemon 发出一个随机挑战（nonce），本地用设备私钥签名作为应答，daemon 验证后签发一个短期令牌（比如 15 分钟有效，自动续期）。WebSocket、tus 上传、Range 下载、VNC 代理全部要求携带这个令牌。
   - **为什么有了 Tailscale 还要这一层**：tailnet 里通常还有你的手机、其他服务器等设备，ACL 一旦配错就全部暴露。这层是纵深防御。
   - 吊销：GUI 里可以删除设备，T2 发生时从另一台设备操作。
4. **授权（应对 T3、T4、T6）**：
   - 文件操作的根目录固定为 `/workspace`，所有路径都要经过统一的净化函数（见 3.4 节）。
   - 用 Claude Code 的权限配置做限制：对敏感路径（`~/.claude/**`、`~/.ssh/**`）设置 deny 规则；需要人工确认的操作，通过 hooks 转成 GUI 弹窗。
   - 审计日志：每一次传输、每一次工具调用、每一次接管，都记录下来，可以查询。
5. **提示词注入（应对 T3）**：这个问题**无法根治**，只能限制它造成的破坏范围：
   - 隔离单元里不放任何与工作无关的密钥。浏览器只登录这项工作必需的账号，不登录主邮箱、银行。
   - Claude 执行的 Bash 命令启用 Claude Code 自带的沙箱（Linux 上基于 bubblewrap），并设置网络白名单。注意：浏览器本身需要访问开放的网络，所以注入攻击仍然可以通过浏览器把数据发出去，这是残余风险。
   - 对外的不可逆操作（发邮件、付款、提交表单），要求人工确认。
   - 定期做快照，出问题可以回滚。
6. **GUI 安全（应对 T5）**：见 3.6 节的 Electron 安全配置。
7. **自研鉴权代码（应对 T6）**：签名、令牌这些不要自己发明，用成熟的库（Node 的 `crypto.sign` 配合 Ed25519，或者 `jose` 库做 JWT）。如果条件允许，鉴权部分找人做一次代码审查。

---

## 6. MVP 范围、里程碑和风险

### 6.1 MVP 包含什么

- 一个远程环境镜像或配置（容器或虚拟机）。
- daemon：配对和鉴权、pty 驱动、hooks 事件、tus 上传、Range 下载、VNC 反向代理、接管锁。
- Electron GUI：配对界面、两栏文件浏览器、传输队列、Claude 终端、事件时间线、嵌入的实时画面、"交给 Claude 处理"按钮。

**MVP 不包含**：WebRTC 推流、多用户、自动更新、代码签名、stream-json 驱动、computer-use MCP。

### 6.2 里程碑和工作量

以下估算针对一位有经验的全栈开发者，全职投入。如果边学边做，乘以 1.5～2。这是粗略估计，不确定性较大。

| 里程碑 | 内容 | 估算 |
|---|---|---|
| M0 远程环境 | 镜像或虚拟机：Xvfb + Xfce + KasmVNC + Chrome（CDP 端口、固定用户数据目录）+ Claude Code + Playwright MCP（`--cdp-endpoint`）+ Tailscale，以及资源限制。验收标准：手动 SSH 进去能让 Claude 操作浏览器，同时在 KasmVNC 里看到画面 | 2～4 天 |
| M1 daemon 骨架 | HTTPS、配对、挑战应答鉴权、WebSocket 控制通道、pty 驱动；GUI 里的 xterm.js 能正常使用 Claude（包括 `/login`） | 4～6 天 |
| M2 文件传输 | tus 上传、Range 下载、哈希校验、原子改名、路径净化、传输队列界面（进度、速度、暂停和继续）、拖拽；用 1 GB 文件做断网测试 | 5～8 天 |
| M3 实时画面 | VNC 反向代理加鉴权、嵌入 noVNC、接管锁 | 2～4 天 |
| M4 联动 | hooks 上报事件 → 时间线；outbox 新文件自动拉取；"交给 Claude 处理"按钮 | 4～7 天 |
| M5 打包 | 三个平台的 Electron 打包；macOS 公证、Windows 签名（需要开发者账号和证书费用）；可选：纯 Web 后备入口 | 3～6 天 |
| **合计** | | **约 4～7 周** |

### 6.3 主要风险

| 风险 | 影响 | 缓解办法 |
|---|---|---|
| Anthropic 条款或计费口径变化（如 Agent SDK 独立额度） | 驱动方式需要调整，或者成本上升 | `ClaudeDriver` 抽象层；默认使用交互式 pty；定期复查官方文档 |
| Claude Code 的终端界面、hooks 格式、会话记录格式变化 | 事件采集失效 | 解析代码写得宽容；用 hooks 而不是解析终端画面；锁定 Claude Code 版本，升级前先测试 |
| 容器里 Chrome 或 Electron 的沙箱问题 | 启动失败，或被迫降低安全性 | 优先选虚拟机或 Incus 系统容器；Docker 方案要在 M0 就验证 |
| Linux 版 Desktop 缺 Computer Use，"其他应用"能力弱 | 只能接社区的 computer-use MCP，效果不确定 | 先确认"其他应用"具体指什么，尽量用命令行替代 |
| 自研鉴权有漏洞 | 远程环境被控制 | Tailscale ACL 兜底；使用成熟的加密库；做代码审查 |
| 维护负担 | 各个依赖持续升级 | MVP 尽量少依赖；锁定版本 |

---

## 7. 和现成工具路线的简短对比

| 情况 | 更适合 |
|---|---|
| 只需要"能看、能操作、能传文件"，三者不需要联动 | 现成工具路线（零开发，当天就能用） |
| 想要"传完文件自动交给 Claude → 处理完自动回传 → 时间线里看到每一步"这样的**联动流水线** | **自研** |
| 需要细粒度的审计、接管锁、按目录授权 | **自研** |
| 以后要分发给别人用（每个人用自己的订阅登录） | **自研**，同时要严格遵守 2.1 节的红线 |
| 时间紧，或者还没确定真实需求 | 先用现成工具跑一两周，把痛点记下来，再决定要不要自研 |

**建议**：两条路线并不冲突。M0（远程环境）对两条路线是同一份工作，可以先完成 M0，用现成工具跑起来，自研部分再在同一个环境上逐步替换。

---

## Sources

- [Claude Code Docs – Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code Docs – Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Code Docs – Authentication](https://code.claude.com/docs/en/authentication)
- [Claude Code Docs – Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless)
- [Claude Code Docs – Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude Code Docs – Costs](https://code.claude.com/docs/en/costs)
- [Claude Code Docs – Sandbox environments](https://code.claude.com/docs/de/sandbox-environments)
- [WinBuzzer – Anthropic Bans Claude Subscription OAuth in Third-Party Apps](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)
- [GitHub – claude-agent-sdk-typescript issue #11: Claude Max Usage](https://github.com/anthropics/claude-agent-sdk-typescript/issues/11)
- [yage.ai – A Claude Code Subscription Is Not a Developer Credential](https://yage.ai/share/claude-code-subscription-not-a-developer-credential-en-20260321.html)
- [claudefa.st – Claude's $200 Agent SDK Credit: Who Wins on June 15?](https://claudefa.st/blog/guide/development/agent-sdk-credit)
- [DEV – What Anthropic's $200 Agent SDK Credit Means If You Run claude -p in Production](https://dev.to/vainamoinen/what-anthropics-200-agent-sdk-credit-means-if-you-run-claude-p-in-production-ce2)
- [digitalapplied – Anthropic Pauses the June 15 Change](https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026)
- [MagnaCapax gist – Agent SDK $200 credit policy change](https://gist.github.com/MagnaCapax/d9177e35b355853f03c730dfcaa693ef)
- [NousResearch/hermes-agent issue #25267](https://github.com/NousResearch/hermes-agent/issues/25267)
- [tus/tusd – reference implementation of the tus resumable upload protocol](https://github.com/tus/tusd)
- [Playwright 1.59 release notes – Screencast (newreleases.io)](https://newreleases.io/project/pypi/playwright/release/1.59.0)
- [TestDino – Playwright 1.59 Release Guide](https://www.testdino.com/blog/playwright-release-guide)
- [playwright-rs screencast source (CDP Page.startScreencast notes)](https://docs.rs/crate/playwright-rs/latest/source/src/protocol/screencast.rs)
- [Sentri runner/screencast.js (CDP screencast to SSE example)](https://rameshbabuprudhvi.github.io/sentri/docs/jsdoc/runner_screencast.js.html)
- [Senko Rašić – Sandboxing AI agents in Linux](https://blog.senko.net/sandboxing-ai-agents-in-linux)
- [InventiveHQ – How to manage permissions and sandboxing](https://inventivehq.com/knowledge-base/claude/how-to-manage-permissions-and-sandboxing)
