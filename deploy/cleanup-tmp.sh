#!/usr/bin/env bash
# 在 VPS 上执行：删除 /tmp 里遗留的部署包（部署包是一次性产物，留着没有价值）。
#
# 用法：
#   bash deploy/cleanup-tmp.sh                     # 删掉 /tmp/turtle-soup-bot-*.tar.gz
#   bash deploy/cleanup-tmp.sh /tmp/xxx.tar.gz     # 只删指定的
#
# 注意：这会真删文件，且不可恢复。删之前建议先跑 deploy/check-tmp.sh 看一眼里面有没有凭证。
set -u
shopt -s nullglob

pkgs=("$@")
if [ ${#pkgs[@]} -eq 0 ]; then
  pkgs=(/tmp/turtle-soup-bot-*.tar.gz)
fi

if [ ${#pkgs[@]} -eq 0 ]; then
  echo "  /tmp 里没有部署包，无需清理"
else
  for p in "${pkgs[@]}"; do
    if [ ! -f "$p" ]; then
      echo "  跳过（不存在）：$p"
      continue
    fi
    rm -f "$p" && echo "  已删除：$p"
  done
fi

echo
echo "== 清理后 /tmp 里剩下的 tar.gz =="
ls -l /tmp/*.tar.gz 2>/dev/null | sed 's/^/  /' || echo "  没有"

echo
echo "== 机器人不受影响（删包只动 /tmp）=="
echo "  服务：$(systemctl is-active turtle-soup-bot)"
echo "  题库：$(node --input-type=commonjs -e "console.log(require('/opt/1panel/apps/turtle-soup-bot/data/questions.json').length)" 2>/dev/null) 题"
