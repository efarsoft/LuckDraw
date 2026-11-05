@echo off
chcp 65001 >nul
title 幸运抽奖系统 - 本地节点

echo ════════════════════════════════════════
echo   幸运抽奖系统 · 现场本地节点
echo ════════════════════════════════════════
echo.

cd /d "%~dp0"

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 18+
    echo 下载地址: https://nodejs.org
    pause
    exit /b 1
)

:: 首次运行：安装依赖
if not exist "node_modules\express" (
    echo [首次] 安装依赖（约1分钟）...
    call npm install --production
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败，请检查网络
        pause
        exit /b 1
    )
)

:: 检查 .env
if not exist ".env" (
    echo [错误] 缺少 .env 配置文件，请从开发机复制
    pause
    exit /b 1
)

echo [启动] 正在启动服务...
start /b node server/index.js

:: 等服务就绪
timeout /t 3 /nobreak >nul

:: 打开管理台和大屏
echo [完成] 管理台: http://localhost:3000/admin
echo [完成] 大屏:   http://localhost:3000/screen
echo.
echo 按 Ctrl+C 停止服务
echo.

start http://localhost:3000/admin
timeout /t 2 /nobreak >nul
start http://localhost:3000/screen

:: 保持窗口
pause >nul
