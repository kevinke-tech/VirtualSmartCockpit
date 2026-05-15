@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist ".venv\Scripts\activate.bat" (
  call ".venv\Scripts\activate.bat"
) else if exist "..\vui\.venv\Scripts\activate.bat" (
  call "..\vui\.venv\Scripts\activate.bat"
)
echo In browser open: http://127.0.0.1:5002/  or http://localhost:5002/
echo Do NOT use http://0.0.0.0:5002/ — browsers reject that URL.
echo Serving SPA + API; copy ..\vui\.env.local here if missing.
python server.py
