#!/usr/bin/env bash
# 在 VPS 上执行：首次装机时创建 systemd 服务（只需跑一次；升级用 deploy/install.sh）。
#
# 用法：bash deploy/service.sh
#
# 说明：
#   Restart=on-failure 是刻意选的：后台界面点「重启进程」时进程以 99 退出，
#   on-failure 正好把它当成「该重开一次」，于是 systemd 会拉起来。
set -e

APP=/opt/1panel/apps/turtle-soup-bot

if [ ! -d "$APP" ]; then
  echo "找不到 $APP，先把部署包解包到那里（见 deploy/README.md）"
  exit 1
fi

if [ -f /etc/systemd/system/turtle-soup-bot.service ]; then
  echo "已存在 /etc/systemd/system/turtle-soup-bot.service，本次只做覆盖前备份："
  cp -a /etc/systemd/system/turtle-soup-bot.service "/root/ts-backup/turtle-soup-bot.service.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null \
    || cp -a /etc/systemd/system/turtle-soup-bot.service /root/turtle-soup-bot.service.bak
fi

cat > /etc/systemd/system/turtle-soup-bot.service <<'EOF'
[Unit]
Description=Turtle Soup Bot (Discord + QQ, Jev judged)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/1panel/apps/turtle-soup-bot
ExecStart=/usr/bin/node src/index.js
# 后台点「重启进程」时进程会以 99 退出，on-failure 正好把它当成"该重开一次"
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo "=== 单元文件 ==="
cat /etc/systemd/system/turtle-soup-bot.service

systemctl daemon-reload
systemctl enable --now turtle-soup-bot

echo "=== 等 8 秒看启动情况 ==="
sleep 8
echo "  active？$(systemctl is-active turtle-soup-bot)"
echo "  enabled？$(systemctl is-enabled turtle-soup-bot)"
echo "  端口：$(ss -ltnp 2>/dev/null | grep 4319 || echo '4319 还没监听')"
echo "=== 启动日志 ==="
journalctl -u turtle-soup-bot -n 20 --no-pager -o cat | sed 's/^/  /'
