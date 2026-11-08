#!/usr/bin/env bash
# 在 Ubuntu 24.04 宿主机上创建 Claude 工作站虚拟机。
#
# ⚠️ 草稿：没有在真实机器上跑过。请逐条执行、看清每一步的输出，不要整段盲跑。
#
# 前提：宿主机已安装 Incus 并完成 `incus admin init`（建议选 btrfs 存储池，见对话里的说明）。
#   sudo apt install incus
#   sudo incus admin init
# 跑 SSH 任务的账号不要加入 incus-admin 组（加入等于拿到 root）。
set -euo pipefail

NAME="${NAME:-claude-ws}"
CPUS="${CPUS:-6}"
MEM="${MEM:-12GiB}"
DISK="${DISK:-150GiB}"

incus launch images:ubuntu/24.04 "$NAME" --vm \
  -c limits.cpu="$CPUS" \
  -c limits.memory="$MEM" \
  -d root,size="$DISK"

echo "等待虚拟机启动……"
until incus exec "$NAME" -- true 2>/dev/null; do sleep 2; done

# 把仓库推进虚拟机，然后在里面执行 provision.sh
incus exec "$NAME" -- bash -c 'useradd -m -s /bin/bash claude || true'
incus file push -r "$(dirname "$0")/../.." "$NAME/home/claude/" --create-dirs
incus exec "$NAME" -- chown -R claude:claude /home/claude

echo
echo "下一步："
echo "  incus exec $NAME -- bash /home/claude/Remote-claude/deploy/vm/provision.sh"
echo "做完配置后建议打一个干净快照："
echo "  incus snapshot create $NAME clean-baseline"
