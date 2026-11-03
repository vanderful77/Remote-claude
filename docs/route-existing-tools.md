# 现成工具路线：用拼装代替开发

> 这份文档研究"不写（或几乎不写）代码，用成熟的现成工具拼出整套系统"的路线。自研路线见 `route-self-built.md`。

## 0. 一句话结论

在 Ubuntu 24.04 上划出一个隔离的"Claude 工作站"（有 `/dev/kvm` 就用 Incus 虚拟机，没有就用 Docker 版 webtop），在里面放 **Xfce 桌面 + Chrome + Claude Code（订阅登录）+ Playwright MCP**，然后用 **Tailscale** 打通网络，用**远程桌面**（RustDesk 或浏览器版 Selkies）实时看画面，用 **Syncthing** 做可续传的双向文件传输。全部需求都能覆盖，**开发量接近零，主要工作是配置**，熟练的话大约一到两天能搭好。

```
本地（任意系统）                                  Ubuntu 24.04 宿主机
┌──────────────────────────┐        ┌──────────────────────────────────────────────┐
│ Tailscale 客户端          │        │ Tailscale（只在虚拟内网暴露服务，公网不开端口） │
│ 远程桌面客户端 / 浏览器    │◀─画面─▶│ ┌──────── 隔离的 Claude 工作站 ──────────────┐ │
│ Syncthing（inbox/outbox） │◀─文件─▶│ │ Xfce（X11）                                │ │
└──────────────────────────┘        │ │  ├ 终端 + tmux：Claude Code（订阅登录）     │ │
                                    │ │  │     └ Playwright MCP ─▶ Chrome（有头、可见）│ │
                                    │ │  ├ RustDesk 或 Selkies（远程桌面服务端）     │ │
                                    │ │  └ Syncthing：~/inbox  ~/outbox             │ │
                                    │ │ 资源上限：CPU / 内存 / 进程数                 │ │
                                    │ └────────────────────────────────────────────┘ │
                                    │ 宿主机本身：给其他设备 SSH 跑别的任务            │
                                    └──────────────────────────────────────────────┘
```

---

## 1. 设计原则：每个需求对应一个成熟工具

这条路线的核心思路是：**每个需求都已经有人做成熟了，我们只负责"选型 + 配置 + 把接缝处理好"。** 真正耗时间的不是装软件，而是接缝，比如显示服务器（X11 还是 Wayland）、浏览器登录状态能否保留、端口暴露到哪里。

| 需求 | 首选工具 | 备选 | 为什么选它 |
|---|---|---|---|
| 跨公网连通 + 加密 | **Tailscale** | 自建 WireGuard、Headscale（自建的 Tailscale 控制端）、RustDesk 自建中继 | 零配置打洞，所有主流系统都有客户端，服务只在虚拟内网可见 |
| 实时画面 + 键鼠操作 | **RustDesk**（虚拟机形态）/ **Selkies·webtop**（Docker 形态） | NoMachine、xrdp、KasmVNC | 跨平台客户端齐全；Selkies 只需要浏览器 |
| Claude harness | **Claude Code**（订阅登录） | Claude Desktop Linux 测试版（作为可选图形前端） | Desktop 在 Linux 上没有 Computer Use，相比 Claude Code 没有额外能力 |
| 浏览器操作 | **Playwright MCP**（有头模式 + 固定用户数据目录） | Chrome DevTools MCP；Claude in Chrome（Linux 支持情况未确认） | 读网页结构而不是像素，稳定、省 token |
| 大文件双向传输 | **Syncthing** | RustDesk 自带传输、`rsync --partial`、Selkies 上传下载 | 分块传输、自动续传、自动校验，网页界面能看到进度 |
| 隔离 + 资源限制 | **Incus 虚拟机** / **Docker** | Incus 系统容器、Multipass | 见下一节 |
| 快照和回滚 | Incus snapshot / Docker 镜像 + 数据卷备份 | — | Claude 环境被弄乱时一键恢复 |

---

## 2. 两种部署形态：先跑一条命令决定

```bash
ls -l /dev/kvm; systemd-detect-virt; nproc; free -h; df -h /
```

- **有 `/dev/kvm`，且内存 ≥ 16 GB** → 选**形态 A：Incus 虚拟机**
- **没有 `/dev/kvm`**（云厂商没开嵌套虚拟化，便宜 VPS 很常见），或内存偏小 → 选**形态 B：Docker webtop**

### 形态 A：Incus 虚拟机

**直觉**：在宿主机里再开一台"独立的小电脑"，然后把它当普通 Ubuntu 桌面机来装。所有教程照搬即可，不用跟容器的各种限制打交道。

- **隔离强度**：有自己的内核，Claude 那边出任何事都要先突破虚拟化层才能碰到宿主机，难度高好几个数量级。
- **资源**：创建时直接限定，例如 4 核、8 GB 内存、60 GB 磁盘。虚拟机自己的系统大约多占 0.5～1 GB 内存。
- **远程桌面**：在虚拟机里装 RustDesk。虚拟机没有物理显示器，所以要用 RustDesk 的 headless 选项（`rustdesk --option allow-linux-headless Y`，官方说默认关闭，主要在 Ubuntu + GNOME 上测过），或者装 `xserver-xorg-video-dummy` 做一个虚拟显示器。
- **文件**：Syncthing 装在虚拟机里，Claude 的 inbox/outbox 也在虚拟机里，宿主机完全不涉及。
- **快照**：`incus snapshot create claude-ws before-xxx`，坏了就恢复。

### 形态 B：Docker webtop（`linuxserver/webtop:ubuntu-xfce`）

**直觉**：别人已经把"Ubuntu + Xfce + 浏览器访问的远程桌面"打包成了一个容器镜像，你拉下来就是一个能用浏览器打开的桌面。

- **远程桌面**：内置 Selkies，**本地只要有浏览器**就能看画面、操作，真正做到和本地系统无关。侧边菜单自带文件上传下载。
- **隔离强度**：中等，和宿主机共用内核。必须遵守第 4 节的 Docker 注意事项。
- **资源**：`--cpus`、`--memory`、`--pids-limit` 直接限制。
- **必须设置 `--shm-size=1gb`**（有的示例用 2g），否则 Chrome 打开稍复杂的网页就崩。原因是 Docker 默认的 `/dev/shm` 只有 64 MB，而 Chrome 用它在进程间传递渲染数据。
- **注意**：webtop 默认不带 Claude Code，要在容器里额外安装，并把 `~/.claude`、浏览器用户数据目录放进持久化数据卷，否则容器重建就要重新登录。镜像的标签和功能会随版本变化，以 LinuxServer 当前文档为准。

### 为什么不首推 Incus 系统容器？

它是两者之间的折中：带 systemd，用起来像独立机器，但和宿主机共用内核。问题在于**远程桌面在系统容器里的现成方案最少**：搜到的 Incus 桌面教程只讲到装桌面，没讲远程访问；RustDesk 依赖完整的登录会话和显示管理器，在容器里能不能正常工作没有可靠资料。只能退而用 xrdp 或 TigerVNC，再把端口转发出来，接缝最多。所以它只适合作为"有经验时的第三选择"。

---

## 3. 各层的配置要点（接缝都在这里）

### 3.1 网络：Tailscale

- 形态 A：宿主机和虚拟机**都可以**装 Tailscale。推荐装在虚拟机里，让它成为虚拟内网里一台独立的设备。这样连 Claude 工作站的流量不经过宿主机上的任何服务，还能用 Tailscale 的访问控制（ACL）规定"只有我的笔记本能连它"。
- 形态 B：Tailscale 装在宿主机上，容器端口**只绑定到 Tailscale 的 IP**（`-p 100.x.y.z:3001:3001`），或者用 Tailscale 自带的 serve 功能转发。
- **绝不要**把远程桌面的端口暴露到公网。这类端口一上线就会被全网扫描、暴力破解。

### 3.2 显示服务器：必须用 X11

Ubuntu 24.04 的 GNOME 默认用 Wayland。Wayland 出于安全考虑，不允许程序直接读整个屏幕、也不允许直接注入按键，所以 RustDesk 和未来可能用到的 xdotool 类 computer-use 工具都会出问题。**直接装 Xfce**，它跑在 X11 上，而且比 GNOME 轻，远程画面更流畅。

### 3.3 Claude Code

1. 用官方安装方式安装，然后在**远程桌面里的终端**执行 `claude` 登录。登录时需要在浏览器里完成订阅账号授权，在远程桌面里操作正好方便。
2. **始终在 tmux 里运行**：`tmux new -s claude`。远程桌面断开或者本地电脑休眠，Claude 都不会中断，下次 `tmux attach -t claude` 接着用。
3. **DISPLAY 这个坑**：Playwright 要把有头浏览器显示到桌面上，就得知道往哪个显示器画（环境变量 `DISPLAY`，比如 `:0` 或 `:1`）。从桌面里打开的终端会自动带上这个变量。但如果你是**通过 SSH 登录后启动的 Claude**，变量是空的，浏览器要么报错，要么跑在你看不到的地方。规则：要么从桌面终端启动，要么手动设置 `DISPLAY`（必要时还有 `XAUTHORITY`）。
4. 可以考虑开启 Claude Code 的内置沙箱（`/sandbox`，Linux 上基于 bubblewrap），给 Claude 执行的命令再加一层文件和网络限制。在 Docker 里可能要用 `enableWeakerNestedSandbox`，名字已经说明这是降级方案。

### 3.4 Playwright MCP：让浏览器可见、登录状态能保留

示意（参数语法以官方 README 为准）：

```bash
claude mcp add playwright -- npx @playwright/mcp@latest --user-data-dir /home/<user>/.pw-profile
```

- **默认是有头模式**（要显式加 `--headless` 才会隐藏），所以浏览器窗口会出现在桌面上，你通过远程桌面就能实时看到。
- `--user-data-dir` 指定一个固定的用户数据目录，网站登录状态会保存在里面，登录一次以后一直有效。反过来，`--isolated` 会把用户数据放在内存里，用完即丢。
- **实时观看的规则**：Claude 操作浏览器时你只看不动。它"看"的是网页结构快照，你手动点一下它并不知道，下一步就可能点错。要接手时先在对话里让它暂停。

### 3.5 Syncthing：用文件夹类型防止误删

Syncthing 的默认行为是**双向镜像**：任何一边删了文件，另一边也会被删。对于"Claude 有权限改文件"的场景，这很危险。解决办法是利用它的文件夹类型：

| 文件夹 | 本地端类型 | 远程端类型 | 效果 |
|---|---|---|---|
| `inbox`（交给 Claude 的材料） | 仅发送（Send Only） | 仅接收（Receive Only） | Claude 在远程改或删了，**不会**影响你本地的原件 |
| `outbox`（Claude 的产出） | 仅接收 | 仅发送 | 本地误删了结果，远程那份还在 |

另外建议开启"文件版本控制"（比如保留最近 5 个版本），文件被覆盖时还能找回旧版本。

**传输时间估算**：1 GB ≈ 8000 Mb。

| 瓶颈带宽 | 理论时间 |
|---|---|
| 100 Mbps | 约 80 秒 |
| 30 Mbps | 约 4.5 分钟 |
| 10 Mbps（常见家用上行） | 约 13 分钟 |

瓶颈通常是**你家宽带的上行**，而不是云服务器。十几分钟里断一次网很常见，Syncthing 会从断点继续，不会从头再来。这正是不用远程桌面自带文件传输来传大文件的原因。

---

## 4. 隔离和安全清单

**通用**
- [ ] 通过 SSH 跑其他任务的账号，**不加入** `docker`、`incus`、`incus-admin` 组。这些组的成员实际上等于 root。
- [ ] 给 Claude 工作站设资源上限（CPU、内存、进程数），保证 Chrome 吃光内存时不会拖垮 SSH 任务。
- [ ] Claude 工作站里**不登录**银行、主邮箱、云服务控制台这类高价值账号。Claude 浏览外部网页时可能遭遇提示词注入。
- [ ] 不把宿主机的 `~/.ssh`、home 目录或 `docker.sock` 共享给工作站。
- [ ] 定期快照或备份。

**Docker 形态额外注意**
- [ ] 端口只绑定到 `127.0.0.1` 或 Tailscale IP。Docker 发布的端口**会绕过 ufw**。
- [ ] 宿主机上的其他服务只监听 `127.0.0.1`，否则容器能通过网桥连到它们。也可以在 `DOCKER-USER` 防火墙链里拦掉。
- [ ] 不使用 `--privileged`。
- [ ] 能用 rootless Docker 或 Podman 的话更好。

---

## 5. 完整走一遍：一次真实任务的流程

场景：你有一个 800 MB 的数据包，要 Claude 解压、清洗，再到某个网站后台上传结果并截图确认。

1. 在本地把数据包拖进 `inbox` 文件夹。Syncthing 开始分块上传，网页界面显示进度。假设上行 30 Mbps，大约 3.5 分钟。中途 Wi-Fi 断了 20 秒，恢复后自动续传。
2. 打开 RustDesk（或浏览器里的 Selkies），看到远程的 Xfce 桌面。终端里的 tmux 会话中，Claude Code 一直在运行。
3. 你输入："`~/inbox/data.zip` 已经到了，解压、清洗，结果放到 `~/outbox/`，然后登录网站后台上传并截图。"
4. Claude 用命令行处理数据。处理完后调用 Playwright MCP，桌面上弹出 Chrome 窗口，你实时看着它打开后台、选择文件、上传。因为之前登录过，用户数据目录里有会话，所以不用重新登录。
5. 截图和结果文件写进 `~/outbox/`，Syncthing 自动同步回你的本地电脑。
6. 你关掉远程桌面窗口。Claude 的会话还在 tmux 里，明天打开还能接着聊。

---

## 6. 这条路线的局限：出现这些信号时考虑自研

| 局限 | 具体表现 |
|---|---|
| **没有统一界面** | 文件进度在 Syncthing 网页里，画面在远程桌面里，对话在终端里，要在三个窗口之间切换 |
| **Claude 的动作不能被程序感知** | 远程桌面只传像素。做不到"Claude 写完结果就自动通知我""传完文件自动触发 Claude 开始处理" |
| **手机上体验一般** | 远程桌面在手机上能用，但在小屏幕上操作终端很别扭 |
| **多用户和权限管理** | 要给别人用、按人分权限、审计谁让 Claude 做了什么时，拼装的方案很难管理 |
| **操作非浏览器的图形界面应用** | 这一点**两条路线都受限**：Linux 上 Claude Desktop 没有 Computer Use，自研也绕不过去，只能接社区的 computer-use MCP，或者换 Windows/macOS |

如果这些都不疼，现成工具路线就是最终方案。如果某一条很疼，再针对那一条自研，比如只做一个"把文件进度、Claude 事件流、远程画面嵌在一起"的本地界面，网络、传输、harness 继续用现成的。

---

## 7. 实施清单（按顺序）

1. 跑第 2 节的检查命令，确定用形态 A 还是形态 B。
2. 宿主机：系统更新，SSH 只允许密钥登录，开启 ufw，安装 Tailscale。
3. 创建 Claude 工作站（Incus 虚拟机，或 Docker webtop），设置资源上限和持久化存储。
4. 工作站内：Xfce（X11）、远程桌面服务端、Chrome、Node.js、Claude Code、Playwright MCP、Syncthing、tmux。
5. 本地：Tailscale、远程桌面客户端（Selkies 只需浏览器）、Syncthing，配好 inbox 和 outbox 的文件夹类型。
6. **验收测试**：
   - [ ] 在 4G 热点等其他网络下也能连上远程桌面（验证跨公网）
   - [ ] 传一个 1 GB 文件，中途断网再恢复，确认续传成功，且两端哈希一致（`sha256sum`）
   - [ ] 让 Claude 打开浏览器登录某个网站；重启工作站后，确认登录状态仍在
   - [ ] 在本地实时看到 Claude 操作浏览器，画面延迟可以接受
   - [ ] 在工作站里制造一个吃内存的进程，确认宿主机上的 SSH 任务不受影响
   - [ ] 在 Claude 处理 inbox 期间删掉一个文件，确认本地原件不受影响
7. 做第一个快照，作为"干净的基线"。

---

## 8. 尚不确定、需要实测的点

- RustDesk 的 headless 模式在 **Ubuntu 24.04 + Xfce + 虚拟机**这个组合上是否顺利。官方说主要在 Ubuntu + GNOME 上测过，如果不行，就退到 dummy 显示驱动，或者改用 NoMachine。
- webtop（Selkies）当前版本的上传大小限制。旧文章提到 200 MB 上限，可能已经变了。不管怎样，大文件都交给 Syncthing。
- Playwright MCP 的参数语法和默认值会随版本变化，以官方 README 为准。
- Claude in Chrome 和 Claude Desktop 测试版在 Linux 上的具体可用性和稳定性没有找到可靠资料。
- 云厂商是否开启嵌套虚拟化，只能在你的机器上实测。

---

## Sources

- [RustDesk for Linux（官方博客，含 headless 选项和 Wayland 说明）](https://rustdesk.com/blog/rustdesk-for-linux)
- [RustDesk "connected, waiting for image" 排查（官方博客）](https://rustdesk.com/blog/rustdesk-connected-waiting-for-image)
- [rustdesk/rustdesk issue #59（headless 相关讨论）](https://github.com/rustdesk/rustdesk/issues/59)
- [h63016401/rustdesk-headless-setup（第三方脚本，未验证）](https://github.com/h63016401/rustdesk-headless-setup)
- [LinuxServer Selkies 文档](https://docs.linuxserver.io/selkies/)
- [Meet Webtops（LinuxServer 博客）](https://blog.linuxserver.io/2021/05/05/meet-webtops-a-linux-desktop-environment-in-your-browser/)
- [Webtop 2.0（LinuxServer 博客）](https://Linuxserver.io/blog/webtop-2-0-the-year-of-the-linux-desktop)
- [Playwright MCP server（目录页）](https://archestra.ai/mcp-catalog/microsoft__playwright-mcp)
- [Linux Desktop Environments in an Incus Container（Scottibyte）](https://discussion.scottibyte.com/t/linux-desktop-environments-in-an-incus-container/444)
- [Install GUI and XRDP for Ubuntu 24.04（LayerStack）](https://layerstack.com/resources/tutorials/how-to-install-GUI-and-XRDP-for-Ubuntu24)
- [Graphical Desktop on Ubuntu Server 24.04 with VNC and RDP（Eurohoster）](https://eurohoster.org/en/knowledgebase/1322/Graphical+Desktop+on+Ubuntu+Server+24.04+with+VNC+and+RDP.html)
- [Claude Desktop on Linux (beta) - Claude Code Docs](https://code.claude.com/docs/en/desktop-linux)
- [Claude Code sandbox environments docs](https://code.claude.com/docs/de/sandbox-environments)
- [How to manage permissions and sandboxing（InventiveHQ）](https://inventivehq.com/knowledge-base/claude/how-to-manage-permissions-and-sandboxing)
