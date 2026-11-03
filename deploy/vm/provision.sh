#!/usr/bin/env bash
# 在 Claude 工作站虚拟机内部（以 root 运行）安装全部组件。
#
# ⚠️ 草稿：没有在真实机器上跑过。软件源地址和包名可能变化，以各项目官方文档为准。
#
# 装完以后的结构：
#   Xvnc :1（TigerVNC，只监听 127.0.0.1:5901）+ Xfce 桌面
#   Chrome（DISPLAY=:1，CDP 只监听 127.0.0.1:9222，固定用户数据目录）
#   Claude Code + Playwright MCP（--cdp-endpoint 连到上面的 Chrome）
#   rcd daemon（只监听 Tailscale IP）
#   Syncthing（/home/claude/workspace）
#   Tailscale
set -euo pipefail
U=claude
H=/home/$U
REPO=$H/Remote-claude

apt-get update
apt-get install -y --no-install-recommends \
  xfce4 xfce4-terminal dbus-x11 tigervnc-standalone-server \
  tmux git curl ca-certificates gnupg fonts-noto-cjk build-essential python3 \
  syncthing

# Node.js 22（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Google Chrome
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
  > /etc/apt/sources.list.d/google-chrome.list
apt-get update && apt-get install -y google-chrome-stable

# Tailscale（装完要手动 `tailscale up` 登录，并在管理后台设置 ACL）
curl -fsSL https://tailscale.com/install.sh | sh

# 以 claude 用户身份安装 Claude Code 和项目依赖
sudo -u $U bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'
sudo -u $U bash -lc "cd $REPO && npm ci"
sudo -u $U mkdir -p $H/workspace $H/.config/systemd/user $H/.config/rcd

# systemd 用户服务：不登录也常驻
loginctl enable-linger $U
cp $REPO/deploy/vm/systemd/*.service $H/.config/systemd/user/
chown -R $U:$U $H/.config

cat <<EOF

基础组件已安装。剩下几步需要人工完成：

1. tailscale up                                  # 登录 tailnet，记下本机的 100.x.y.z
2. 编辑 $H/.config/rcd/config.json（参考 $REPO/deploy/vm/rcd.config.example.json），listen.host 填上面的 IP
3. 以 claude 用户：
     systemctl --user daemon-reload
     systemctl --user enable --now rc-vnc rc-desktop rc-chrome syncthing rcd
4. 登录 Claude Code（只需一次）：
     tmux -L rcd attach -t claude      # 在里面执行 /login，按提示在浏览器里授权
5. 接上 Playwright MCP（版本号请锁定为一个具体版本）：
     claude mcp add playwright -- npx @playwright/mcp@<版本> --cdp-endpoint http://127.0.0.1:9222
6. 把 hooks 配置合并进 ~/.claude/settings.json：
     cd $REPO && npx tsx packages/daemon/src/cli.ts hooks-config
7. 生成配对码，在本地执行 rc pair：
     cd $REPO && npx tsx packages/daemon/src/cli.ts pair
8. 确认环境里没有 ANTHROPIC_API_KEY（否则可能走 API 计费）：
     env | grep -i anthropic || echo OK
EOF
