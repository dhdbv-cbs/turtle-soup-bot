@echo off
title 海龟汤机器人
cd /d "%~dp0"
echo ========================================
echo   海龟汤机器人启动中...
echo ========================================
echo.
node src/index.js
echo.
echo 机器人已退出，按任意键关闭窗口...
pause >nul
