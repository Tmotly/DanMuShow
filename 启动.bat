@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
title DanMuShow 弹幕面板
cd /d "%~dp0"

echo.
echo  ==========================================
echo    DanMuShow  多平台直播弹幕面板
echo  ==========================================
echo.

rem ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 goto no_node

for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
if not defined NODE_VER goto no_node
set "NODE_MAJOR=!NODE_VER:~1,2!"
set "NODE_MAJOR=!NODE_MAJOR:.=!"
if !NODE_MAJOR! LSS 18 goto old_node

echo  [1/3] Node.js !NODE_VER!  已就绪
echo.

rem ---------- 2. 安装依赖 ----------
if exist "node_modules\ws\package.json" goto run

echo  [2/3] 首次运行，正在安装依赖（只有一个 ws，很快）...
echo.
call npm install --no-audit --no-fund
if exist "node_modules\ws\package.json" goto run

echo.
echo  直连 npm 失败，改用国内镜像重试...
call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
if not exist "node_modules\ws\package.json" goto npm_fail

rem ---------- 3. 启动 ----------
:run
echo.
echo  [3/3] 正在启动，稍后会自动打开控制台网页...
echo.
echo    控制台  http://127.0.0.1:7801/control.html
echo    面板    http://127.0.0.1:7801/
echo.
echo  关掉这个窗口 = 停止服务
echo.
node server/index.js --open
echo.
echo  服务已停止。
echo  按任意键关闭窗口。
pause >nul
exit /b 0

:no_node
echo  [错误] 这台电脑还没有安装 Node.js，程序跑不起来。
echo.
echo  解决步骤：
echo    1) 下面地址会自动打开，下载 LTS 版本（Windows 安装包 .msi）
echo    2) 双击安装包，一路点 下一步 装完
echo    3) 关掉本窗口，重新双击 启动.bat
echo.
start "" https://nodejs.org/zh-cn/download
echo  没自动打开的话，手动访问：https://nodejs.org/zh-cn/download
echo.
echo  按任意键关闭窗口。
pause >nul
exit /b 1

:old_node
echo  [错误] Node.js 版本太旧：!NODE_VER!
echo  需要 18 或更高版本，请到下面地址装新版：
echo    https://nodejs.org/zh-cn/download
echo.
echo  按任意键关闭窗口。
pause >nul
exit /b 1

:npm_fail
echo.
echo  [错误] 依赖安装失败。
echo  请检查网络后重试；还是不行就把本窗口截图发给我。
echo.
echo  按任意键关闭窗口。
pause >nul
exit /b 1
