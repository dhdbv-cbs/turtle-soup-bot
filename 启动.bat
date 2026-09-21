@echo off
chcp 65001 >nul
title 海龟汤机器人
cd /d "%~dp0"
rem 告诉机器人「是我在看着你」：后台点「重启进程」时它会以退出码 99 退出，由这个窗口重开，
rem 这样始终只有一个进程，控制台也始终是这一个（自己再 spawn 一个会有两个进程抢消息）。
set TURTLE_SUPERVISOR=bat
echo ========================================
echo   海龟汤机器人启动中...
echo ========================================
echo.
echo   后台界面：http://127.0.0.1:4319
echo   首次使用请在界面里设置后台密码，所有配置都在界面里改。
echo.
rem 稍等几秒再打开浏览器，确保服务已开始监听（改过端口请手动访问）
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:4319'"

:run
node src/index.js
rem 99 = 后台点了「重启进程」：重开一轮，不退出这个窗口
if "%errorlevel%"=="99" (
  echo.
  echo   正在重启...
  echo.
  goto run
)

echo.
echo   机器人已退出，按任意键关闭窗口...
pause >nul
