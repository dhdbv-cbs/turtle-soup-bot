#!/usr/bin/env bash
# 在 VPS 上执行：把部署包解包上线 → 重启 → 校验。全程可回滚。
#
# 用法：
#   bash deploy/install.sh /tmp/turtle-soup-bot-<sha>.tar.gz
#   bash deploy/install.sh /tmp/turtle-soup-bot-<sha>.tar.gz --yes   # 最近有对局动静时跳过确认
#
# 设计要点：
#   1) 解包前先拦一道：包里若含 data/ 直接拒绝（那会把线上题库和配置覆盖掉）。
#   2) 解包只覆盖源码，node_modules/ 与 data/ 原样保留。
#   3) 全程不删任何东西：当前源码与 data/ 都会先备份到 /root/ts-backup/。
set -euo pipefail

APP=/opt/1panel/apps/turtle-soup-bot
BACKUP=/root/ts-backup
PKG="${1:-}"
CONFIRM="${2:-}"
STAMP=$(date +%Y%m%d-%H%M%S)

if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then
  echo "用法: bash deploy/install.sh /tmp/turtle-soup-bot-<sha>.tar.gz [--yes]"
  exit 2
fi

echo "== 0. 部署包校验 =="
echo "  包：$PKG（$(stat -c %s "$PKG") 字节，md5 $(md5sum "$PKG" | cut -d' ' -f1)）"
if tar -tzf "$PKG" | grep -q '^turtle-soup-bot/data/'; then
  echo "  [X] 包里含 data/，已拒绝解包。"
  echo "      这会把线上题库（和带密钥的 config.json）覆盖成打包机上的版本。"
  echo "      请改用 deploy/package.ps1 打包，它会排除 data/。"
  exit 3
fi
echo "  [OK] 包里没有 data/"

echo
echo "== 1. 现在的状态（重启会清掉内存里的对局）=="
echo "  服务：$(systemctl is-active turtle-soup-bot)（启动于 $(systemctl show -p ActiveEnterTimestamp --value turtle-soup-bot)）"
echo "  题库：$(node --input-type=commonjs -e "console.log(require('$APP/data/questions.json').length)") 题"
echo "  最近 3 分钟日志："
journalctl -u turtle-soup-bot --since '3 min ago' --no-pager -o cat 2>/dev/null | tail -5 | sed 's/^/    /' || true
RECENT=$(journalctl -u turtle-soup-bot --since '3 min ago' --no-pager 2>/dev/null | wc -l)
if [ "$RECENT" -gt 0 ] && [ "$CONFIRM" != "--yes" ]; then
  echo
  echo "  [!] 最近 3 分钟内有日志，可能有人在玩（提示：玩家提问不写日志，"
  echo "      所以还要看频道消息，见 deploy/check-activity.sh）。"
  echo "      确认要在这时候重启，请加 --yes 重跑。"
  exit 4
fi

echo
echo "== 2. 备份当前源码与 data =="
mkdir -p "$BACKUP"
tar -czf "$BACKUP/src-$STAMP.tar.gz" --exclude=node_modules --exclude=data -C /opt/1panel/apps turtle-soup-bot
cp -a "$APP/data" "$BACKUP/data-$STAMP"
ls -l "$BACKUP" | tail -3 | sed 's/^/  /'

echo
echo "== 3. 解包（只覆盖源码）=="
tar -xzf "$PKG" --no-same-owner -C /opt/1panel/apps
echo "  src/platforms/：$(ls "$APP/src/platforms/" | tr '\n' ' ')"

echo
echo "== 4. 权限（含密钥的 data/ 更严）=="
cd "$APP"
find . -path ./node_modules -prune -o -type d -exec chmod 755 {} +
find . -path ./node_modules -prune -o -type f -exec chmod 644 {} +
chmod 700 data
chmod 600 data/config.json

echo
echo "== 5. 题库与配置没被碰 =="
node --input-type=commonjs -e "const q=require('$APP/data/questions.json');console.log('  题库：'+q.length+' 题')"
node --input-type=commonjs -e "const c=require('$APP/data/config.json');console.log('  config.json 里 discord.token 长度：'+((c.discord.token||'').length))"

echo
echo "== 6. 重启 =="
systemctl restart turtle-soup-bot
sleep 12
echo "  服务：$(systemctl is-active turtle-soup-bot)"
journalctl -u turtle-soup-bot -n 25 --no-pager -o cat | tail -16 | sed 's/^/  /'

echo
echo "== 7. 校验（详见 deploy/verify.sh）=="
bash "$(dirname "$0")/verify.sh" || true

echo
echo "== 回滚方法（万一有问题）=="
echo "  tar -xzf $BACKUP/src-$STAMP.tar.gz -C /opt/1panel/apps && systemctl restart turtle-soup-bot"
echo "  （data 备份在 $BACKUP/data-$STAMP/，本次没有改动它）"
