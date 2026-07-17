$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$python = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (!(Test-Path $python)) {
  throw "Missing .venv. Run: powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1"
}

& $python server.py
