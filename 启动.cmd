@echo off
chcp 65001 >nul
title 2nkpoker

rem ============================================================
rem  双击本文件 = 启动 2nkpoker（后端 3001 + 前端 8080）
rem  窗口会一直开着，关掉窗口或按 Ctrl+C = 停止服务。
rem
rem  两个人试玩：普通窗口 + 无痕窗口各开一个地址
rem    http://127.0.0.1:8080
rem  手机试玩：同一 Wi-Fi，用启动后打印的"同一 Wi-Fi"那一行地址
rem ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node。请安装 Node.js 20 以上版本，并确保安装时勾选了加入 PATH。
  echo        装好后重新打开这个窗口再试。
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    echo [提示] 没找到 .env，已自动从 .env.example 复制一份。
    copy /y ".env.example" ".env" >nul
  ) else (
    echo [错误] 缺少 .env 和 .env.example。
    pause
    exit /b 1
  )
)

node start.mjs %*
set EXITCODE=%errorlevel%

echo.
echo ================================================
echo   服务已退出（退出码 %EXITCODE%）
if not "%EXITCODE%"=="0" echo   看上面最后几行的报错；端口被占就换一个：启动.cmd --port 9000
echo ================================================
echo.
pause