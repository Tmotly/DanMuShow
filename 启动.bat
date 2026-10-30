@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 Node.js，请先装 Node 22 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
  )
)

echo 正在启动弹幕聚合面板...
start "" http://127.0.0.1:7801/control.html
node server/index.js
pause
