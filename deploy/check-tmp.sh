#!/usr/bin/env bash
# 在 VPS 上执行：检查 /tmp 里遗留的部署包有没有夹带凭证（只读）。
#
# 为什么需要它：部署包要放 /tmp 才能解包，而 /tmp 是 1777（谁都能读）。
# 早期的一次打包把 data/config.json 打进去了，等于在 /tmp 放了一份明文密钥。
# deploy/package.ps1 现在会拦住这种包，这个脚本用来复查历史遗留。
#
# 用法：
#   bash deploy/check-tmp.sh                       # 检查 /tmp/turtle-soup-bot-*.tar.gz
#   bash deploy/check-tmp.sh /tmp/xxx.tar.gz       # 检查指定包
set -u
shopt -s nullglob

pkgs=("$@")
if [ ${#pkgs[@]} -eq 0 ]; then
  pkgs=(/tmp/turtle-soup-bot-*.tar.gz)
fi

if [ ${#pkgs[@]} -eq 0 ]; then
  echo "  /tmp 里没有部署包（干净的）"
  exit 0
fi

for p in "${pkgs[@]}"; do
  if [ ! -f "$p" ]; then
    echo "  跳过（不存在）：$p"
    continue
  fi
  echo "== $p =="
  stat -c '  权限=%a  属主=%U  大小=%s 字节  改动=%y' "$p" | sed 's/^/  /'
  echo "  条目数：$(tar -tzf "$p" 2>/dev/null | wc -l)"
  if tar -tzf "$p" 2>/dev/null | grep -q '^turtle-soup-bot/data/'; then
    echo "  [!] 这个包含 data/，可能夹带 config.json 里的凭证："
    tar -xzOf "$p" turtle-soup-bot/data/config.json 2>/dev/null \
      | grep -oE '"(apiKey|token|passwordHash|passwordSalt|appSecret|secret)"' \
      | sort | uniq -c | sed 's/^/      /'
    echo "      → 尽快删掉：bash deploy/cleanup-tmp.sh $p"
    echo "      → 若这份包曾被别处保留过，考虑轮换其中的令牌"
  else
    echo "  [OK] 不含 data/，没有凭证"
  fi
done
