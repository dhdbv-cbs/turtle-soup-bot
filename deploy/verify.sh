#!/usr/bin/env bash
# 在 VPS 上执行：部署后健康检查（只读，不改任何东西）。
# 用法：bash deploy/verify.sh
set -u

APP=/opt/1panel/apps/turtle-soup-bot
# 后台端口：优先环境变量 ADMIN_PORT，其次从线上配置里读，最后退回默认 4319
PORT="${ADMIN_PORT:-}"
if [ -z "$PORT" ]; then
  PORT=$(node --input-type=commonjs -e "try{const c=require('$APP/data/config.json');process.stdout.write(String((c.admin&&c.admin.port)||''))}catch(e){}" 2>/dev/null)
fi
PORT="${PORT:-4319}"

echo "== 现在 =="
date -Is
echo "  服务：$(systemctl is-active turtle-soup-bot)（启动于 $(systemctl show -p ActiveEnterTimestamp --value turtle-soup-bot)）"
echo "  重启次数 NRestarts=$(systemctl show -p NRestarts --value turtle-soup-bot)"

PID=$(systemctl show -p MainPID --value turtle-soup-bot)
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  echo "  主进程 PID=$PID"
  ps -o rss=,etime= -p "$PID" | awk '{printf "  内存 %.1f MB，已运行 %s\n", $1/1024, $2}'
  echo "  工作目录：$(readlink /proc/$PID/cwd)"
  echo "  启动命令：$(tr '\0' ' ' < /proc/$PID/cmdline)"
fi

echo
echo "== 题库 / 端口 / 后台接口 =="
node --input-type=commonjs -e "console.log('  题库：'+require('$APP/data/questions.json').length+' 题')" 2>&1
ss -ltnp 2>/dev/null | grep ":$PORT" | sed 's/^/  /' || echo "  $PORT 未监听"
curl -s -m 5 "http://127.0.0.1:$PORT/api/state" | sed 's/^/  /'
echo
echo "  对外是否可达（应当连不上）："
timeout 3 curl -s -o /dev/null "http://$(hostname -I | awk '{print $1}'):$PORT/api/state" \
  && echo "    [!] 竟然能从本机对外地址访问，检查监听地址" \
  || echo "    [OK] 只监听 127.0.0.1"

echo
echo "== 已注册的斜杠命令 =="
journalctl -u turtle-soup-bot --since '10 min ago' --no-pager -o cat 2>/dev/null | grep '斜杠命令' | tail -2 | sed 's/^/  /' || echo "  （最近 10 分钟没有注册记录）"

echo
echo "== 告警 / 错误（最近 10 分钟）=="
HITS=$(journalctl -u turtle-soup-bot --since '10 min ago' --no-pager 2>/dev/null | grep -iE 'warn|error|失败|ECONN|unhandled|reject' || true)
if [ -n "$HITS" ]; then echo "$HITS" | tail -10 | sed 's/^/  /'; else echo "  （没有）"; fi
