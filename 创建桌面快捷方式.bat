@echo off
chcp 65001 >nul
set "PROJECT_DIR=%~dp0"
set "TARGET=%PROJECT_DIR%启动工作台.bat"
set "SHORTCUT=%USERPROFILE%\Desktop\镜序工作台.lnk"
if not exist "%TARGET%" (
  echo 找不到启动文件：%TARGET%
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath='%TARGET%'; $s.WorkingDirectory='%PROJECT_DIR%'; $s.Description='镜序本地短剧工作台'; $s.Save()"
if errorlevel 1 (echo 创建快捷方式失败，请确认当前账户可以写入桌面。) else (echo 已创建桌面快捷方式：%SHORTCUT% & echo 以后双击桌面的“镜序工作台.lnk”即可启动。)
pause
