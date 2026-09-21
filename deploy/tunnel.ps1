# 本地：把 VPS 上的机器人后台（127.0.0.1:4319）映射到本机，用浏览器就能登录后台。
#
# 地址、端口、私钥路径**不写死在仓库里**（本仓库是公开的）。按下面的顺序取：
#   1) 命令行参数：-VpsHost / -VpsPort / -KeyPath / -LocalPort
#   2) 环境变量：  TS_VPS_HOST / TS_VPS_PORT / TS_SSH_KEY / TS_LOCAL_PORT
#
# 用法示例：
#   powershell -ExecutionPolicy Bypass -File deploy\tunnel.ps1 `
#       -VpsHost 203.0.113.10 -VpsPort 25751 -KeyPath C:\ssh\my_key
#   然后浏览器打开 http://127.0.0.1:14319 （用后台密码登录）
#
# 窗口保持开着就是通的；关掉窗口隧道立即断开（VPS 上的机器人不受影响，一直在跑）。

param(
    [string]$VpsHost = '',
    [string]$VpsPort = '',
    [string]$KeyPath = '',
    [string]$LocalPort = '',
    [string]$RemotePort = '4319',
    [string]$User = 'root'
)

$ErrorActionPreference = 'Stop'

if (-not $VpsHost) { $VpsHost = $env:TS_VPS_HOST }
if (-not $VpsPort) { $VpsPort = $env:TS_VPS_PORT }
if (-not $KeyPath) { $KeyPath = $env:TS_SSH_KEY }
if (-not $LocalPort) { $LocalPort = $env:TS_LOCAL_PORT }
if (-not $VpsPort) { $VpsPort = '22' }
if (-not $LocalPort) { $LocalPort = '14319' }

if (-not $VpsHost) {
    throw "缺少 VPS 地址。用 -VpsHost <地址> 或设环境变量 TS_VPS_HOST（端口/密钥同理：-VpsPort、-KeyPath）"
}

$sshArgs = @(
    '-N',
    '-L', "$LocalPort`:127.0.0.1:$RemotePort",
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-p', $VpsPort
)
if ($KeyPath) { $sshArgs += @('-i', $KeyPath) }
$sshArgs += "$User@$VpsHost"

Write-Output "隧道：http://127.0.0.1:$LocalPort  →  $User@${VpsHost}:$VpsPort 的 127.0.0.1:$RemotePort"
if ($KeyPath) { Write-Output "私钥：$KeyPath" } else { Write-Output "私钥：（未指定，用 ssh 默认密钥 / ssh-agent）" }
Write-Output "按 Ctrl+C 断开。"
& ssh @sshArgs
