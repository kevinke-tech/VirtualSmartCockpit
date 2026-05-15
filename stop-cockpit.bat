@echo off
chcp 65001 >nul
title Cockpit Demo - Stop
echo.
echo Stopping Virtual Smart Cockpit (port 5002)...
echo.

set "DIR=%~dp0"

if exist "%DIR%logs\backend.pid" (
    set /pBPID=<"%DIR%logs\backend.pid"
    taskkill /PID %BPID% /T /F >nul 2>&1
    del "%DIR%logs\backend.pid" >nul 2>&1
    echo [OK] Stopped PID from logs\backend.pid
)

taskkill /FI "WINDOWTITLE eq Cockpit*" /F >nul 2>&1

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5002" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /PID %%a /T /F >nul 2>&1
    echo [OK] Freed port 5002 (PID %%a^)
)

echo.
echo Cockpit demo stopped.
timeout /t 2 /nobreak >nul
