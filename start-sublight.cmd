@echo off
setlocal
cd /d "%~dp0"
title Sublight WebUI
echo.
echo Starting Sublight WebUI...
echo.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2; try { $s = Get-Content -Raw -Path '%~dp0settings.json' | ConvertFrom-Json; $port = if ($s.port) { $s.port } else { 3700 } } catch { $port = 3700 }; Start-Process ('http://127.0.0.1:' + $port + '/')"
call npm start
echo.
echo Server exited. Press any key to close.
pause >nul
