# 本地打包部署包（Windows PowerShell 5.1 可直接运行）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File deploy\package.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\package.ps1 -OutDir D:\tmp
#
# 关键约定（踩过一次，务必保留这道闸）：
#   仓库里的 data/questions.json 只有 3 题样例，线上题库有几百题，而且线上还有
#   带密钥的 data/config.json。**部署包里绝不能包含 data/**，否则解包会把线上
#   题库和配置覆盖成打包机上的版本。这里用 git archive 只打「入库内容」，
#   再用 :(exclude)data 显式排掉 data/，最后强制校验一遍才允许出包。
#
# 出包后上传到 VPS 的 /tmp，再在 VPS 上跑 deploy/install.sh（见 deploy/README.md）。

param(
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repo 'package.json'))) {
    throw "没找到仓库根目录（deploy 的上一级应当是仓库）：$repo"
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = (Get-Location).Path
}
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

$sha = (git -C $repo rev-parse --short HEAD).Trim()
$pkgName = "turtle-soup-bot-$sha.tar.gz"
$out = Join-Path $OutDir $pkgName

Write-Output "=== 1. 打包 HEAD = $sha ==="
# 未提交的改动不会进包：先提醒
$dirty = git -C $repo status --porcelain
if ($dirty) {
    Write-Output "  注意：工作区有未提交改动，它们不会进包："
    $dirty | ForEach-Object { "    $_" }
}

git -C $repo archive --format=tar.gz --prefix=turtle-soup-bot/ -o $out HEAD -- . ':(exclude)data'
if ($LASTEXITCODE -ne 0) { throw "git archive 失败（exit $LASTEXITCODE）" }

Write-Output ""
Write-Output "=== 2. 硬校验：包里不许有 data/、密钥文件 ==="
$list = @(tar -tzf $out)
if (-not $list -or $list.Count -lt 10) { throw "包内容异常，条目数 $($list.Count)" }

$forbidden = @($list | Select-String -Pattern '^turtle-soup-bot/data/|(^|/)\.env$|(^|/)\.env\.|config\.json$|\.pem$|\.key$')
if ($forbidden.Count -gt 0) {
    # .env.example 是允许的样板文件
    $forbidden = @($forbidden | Where-Object { $_.Line -notmatch '\.env\.example$' })
}
if ($forbidden.Count -gt 0) {
    Remove-Item $out -Force
    Write-Output "  [X] 包里混进了不该有的文件，已删除该包并中止："
    $forbidden | ForEach-Object { "      $($_.Line)" }
    throw "打包被安全校验拦下"
}
Write-Output "  [OK] 不含 data/、不含 .env、不含 config.json"

Write-Output ""
Write-Output "=== 3. 抽查关键文件是否在包里 ==="
foreach ($need in @('turtle-soup-bot/src/index.js', 'turtle-soup-bot/src/platforms/discordCards.js', 'turtle-soup-bot/package.json')) {
    if ($list -contains $need) { Write-Output "  [OK] $need" } else { Write-Output "  [!] 缺 $need（若该文件已改名请同步本脚本）" }
}

Write-Output ""
Write-Output "=== 4. 结果 ==="
$item = Get-Item $out
Write-Output "  包：$($item.FullName)"
Write-Output "  大小：$([math]::Round($item.Length / 1KB, 1)) KB，条目数 $($list.Count)"
Write-Output "  md5：$((Get-FileHash $out -Algorithm MD5).Hash.ToLower())"
Write-Output ""
Write-Output "  下一步：把包传到 VPS 的 /tmp，然后在 VPS 上执行"
Write-Output "    bash /opt/1panel/apps/turtle-soup-bot/deploy/install.sh /tmp/$pkgName"
