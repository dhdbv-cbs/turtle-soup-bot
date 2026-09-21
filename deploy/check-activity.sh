#!/usr/bin/env bash
# 在 VPS 上执行：看「此刻有没有人在玩」（只读）。
#
# 为什么需要它：
#   /api/state 只返回 needsSetup/authenticated/passwordMinLength/version，
#   **看不到是否有进行中的对局**；而且玩家普通提问根本不写日志，
#   所以「日志安静」只能算弱证据。要确认现在能不能重启，得直接看频道消息。
#
# 用法：
#   bash deploy/check-activity.sh
#   TS_WATCH_CHANNELS="频道id1,频道id2" bash deploy/check-activity.sh   # 额外拉这几个频道最新消息时间
set -u

APP=/opt/1panel/apps/turtle-soup-bot

echo "== 现在 =="
date -Is
echo "  服务启动于：$(systemctl show -p ActiveEnterTimestamp --value turtle-soup-bot)"

echo
echo "== 最近 15 分钟的日志 =="
journalctl -u turtle-soup-bot --since '15 min ago' --no-pager -o cat 2>/dev/null | tail -10 | sed 's/^/  /' \
  || echo "  （没有日志）"

echo
echo "== 最近 3 小时的开局 / 结束 / 切模式 =="
journalctl -u turtle-soup-bot --since '3 hours ago' --no-pager -o cat 2>/dev/null \
  | grep -E '游戏开始|通关|公布|回答方式|丢弃' | tail -12 | sed 's/^/  /' || echo "  （没有）"

echo
echo "== 最近 8 条日志（判断当前处于哪一步）=="
journalctl -u turtle-soup-bot -n 8 --no-pager -o cat 2>/dev/null | sed 's/^/  /'

if [ -n "${TS_WATCH_CHANNELS:-}" ]; then
  echo
  echo "== 指定频道的最新消息（只打印时间 / 玩家还是机器人 / 开头几个字）=="
  node --input-type=commonjs -e "
    const cfg = require('$APP/data/config.json');
    const token = (cfg.discord && cfg.discord.token) || '';
    const ids = String(process.env.TS_WATCH_CHANNELS).split(',').map((s) => s.trim()).filter(Boolean);
    if (!token) { console.log('  （配置里没有 discord.token，跳过）'); process.exit(0); }
    (async () => {
      for (const id of ids) {
        try {
          const res = await fetch('https://discord.com/api/v10/channels/' + id + '/messages?limit=5', {
            headers: { Authorization: 'Bot ' + token },
          });
          const arr = await res.json();
          console.log('  频道 ' + id + '：');
          if (!Array.isArray(arr)) { console.log('    接口返回：' + JSON.stringify(arr).slice(0, 160)); continue; }
          for (const m of arr) {
            const who = m.author && m.author.bot ? '[机器人]' : '[玩家] ';
            const text = String(m.content || '').replace(/\s+/g, ' ').slice(0, 40);
            console.log('    ' + m.timestamp + '  ' + who + '  ' + text);
          }
        } catch (e) {
          console.log('    请求失败：' + e.message);
        }
      }
    })();
  "
fi

echo
echo "== 结论怎么读 =="
echo "  · 上面最后一条玩家消息越久远，越像没人在玩；"
echo "  · 但「提问不写日志」，所以务必看频道消息时间，不能只看日志；"
echo "  · 当前若有一局在「游戏开始」之后既没「通关」也没「公布」，那局就是在进行中，重启会清掉它。"
