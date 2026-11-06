@echo off
chcp 65001 >nul 2>&1
title LuckyDraw

echo.
echo  ==========================================
echo    LuckyDraw - Local Node
echo  ==========================================
echo.

cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Please install Node.js 18+
    echo  Download: https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo  [OK] Node.js %NODE_VER%

:: Install dependencies on first run
if not exist "node_modules\express" (
    echo  [SETUP] Installing dependencies, please wait...
    call npm install --production
    if %errorlevel% neq 0 (
        echo  [ERROR] npm install failed
        pause
        exit /b 1
    )
    echo  [OK] Dependencies installed
)

:: Check .env
if not exist ".env" (
    echo  [ERROR] .env not found. Copy it from dev machine.
    pause
    exit /b 1
)

:: Kill existing node processes on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Start server
echo  [START] Launching server...
start /b node server/index.js

:: Wait for server ready
set /a tries=0
:wait_loop
timeout /t 1 /nobreak >nul
set /a tries+=1
curl -s -o nul http://localhost:3000/api/health 2>nul
if %errorlevel% equ 0 goto :ready
if %tries% lss 10 goto :wait_loop
echo  [ERROR] Server failed to start. Check console output.
pause
exit /b 1

:ready
echo  [OK] Server running
echo.
echo  Admin:  http://localhost:3000/admin
echo  Screen: http://localhost:3000/screen
echo.
echo  Press Ctrl+C to stop
echo.

:: Open browser
start http://localhost:3000/admin
timeout /t 2 /nobreak >nul
start http://localhost:3000/screen

:: Keep window open
cmd /k
