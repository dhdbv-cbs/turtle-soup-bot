@echo off
title 海龟汤机器人
cd /d "%~dp0"
echo ========================================
echo   海龟汤机器人启动中...
echo ========================================
echo.
echo   后台界面：http://127.0.0.1:4319
echo   首次使用请在界面里设置后台密码，所有配置都在界面里改。
echo.
rem 稍等几秒再打开浏览器，确保服务已开始监听（改过端口请手动访问）
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:4319'"
node src/index.js
echo.
echo 机器人已退出，按任意键关闭窗口...
pause >nul
