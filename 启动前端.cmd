@echo off
chcp 65001 >nul
title 2nkpoker 前端（局域网可访问）

rem ============================================================
rem  双击本文件即可启动前端。窗口会一直开着，关掉窗口 = 停止服务。
rem  本服务监听 0.0.0.0，所以同一局域网（同一 Wi-Fi）的手机/平板/其他电脑都能访问。
rem
rem  启动后看窗口里打印的 "LAN access" 一行，那就是手机要打开的地址，例如：
rem     http://10.192.53.199:8080/?api=http://43.135.53.83:3000&table=abc123&proto=remote
rem  把 table= 后面换成任意房号：两个人用同一个房号就会坐在同一桌。
rem
rem  手机连不上时按顺序排查：
rem    1) 手机和电脑必须连同一个 Wi-Fi（不要一个走流量、一个走网线到别的网段）
rem    2) 用管理员身份开一个 CMD，执行一次放行命令（见窗口里的 firewall 提示）
rem    3) 若手机 ping 不通电脑，说明路由器开启了"AP 隔离/客户端隔离"，
rem       改用手机热点让电脑连上去，或直接连远端后端
rem ============================================================

rem 关键：先切到本文件所在目录（项目根），这样无论从哪里双击都正确
cd /d "%~dp0"

echo ================================================
echo   2nkpoker 前端启动中（同一 Wi-Fi 的设备都能访问）
echo   项目目录：%CD%
echo ================================================
echo.

if not exist "apps\web\start.mjs" (
  echo [错误] 在 %CD% 下找不到 apps\web\start.mjs
  echo        请把这个 cmd 文件放在项目根目录（和 apps、packages 同一层）再运行。
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node。请安装 Node.js 20 以上版本，并确保安装时勾选了加入 PATH。
  echo        装好后重开这个窗口再试。
  echo.
  pause
  exit /b 1
)

echo Node 版本：
node -v
echo.
echo 稍等即可看到 "LAN access" 与 "page" 两行地址：
echo   · 本机浏览器用 http://localhost:8080
echo   · 手机用 LAN access 里那个 http://192.168.x.x:8080
echo 停止服务：关闭本窗口，或按 Ctrl+C
echo.

node "apps\web\start.mjs" --port 8080
set EXITCODE=%errorlevel%

echo.
echo ================================================
echo   前端已退出（退出码 %EXITCODE%）
if "%EXITCODE%"=="1" echo   若提示端口被占用，说明已经有一个前端在跑了：
if "%EXITCODE%"=="1" echo   直接访问 http://localhost:8080 即可，或先关掉那个窗口。
echo ================================================
echo.
pause
