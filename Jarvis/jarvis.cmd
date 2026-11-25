@echo off
chcp 65001 >nul
cd /d "%~dp0"
set JARVIS_OPEN=1
node server.mjs
echo.
echo Jarvis остановлен. Нажмите любую клавишу, чтобы закрыть окно.
pause >nul
