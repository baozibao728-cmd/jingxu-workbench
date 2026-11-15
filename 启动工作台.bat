@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或以上版本。
  pause
  exit /b 1
)
start "" "http://127.0.0.1:6040"
echo 工作台运行时请保留此窗口。关闭窗口会停止后台。
node --env-file-if-exists=.env src/server.js
pause
