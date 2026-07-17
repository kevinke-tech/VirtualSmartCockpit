$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$venvRoot = Join-Path $repoRoot ".venv"
$python = Join-Path $venvRoot "Scripts\python.exe"

if (!(Test-Path $python)) {
  Write-Host "[setup] Creating Python virtual environment at .venv ..."
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3.12 -m venv $venvRoot
  } else {
    & python -m venv $venvRoot
  }
}

if (!(Test-Path $python)) {
  throw "Failed to create .venv. Install Python 3.12 and retry."
}

Write-Host "[setup] Installing Python dependencies ..."
& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $repoRoot "requirements.txt")

$envLocal = Join-Path $repoRoot ".env.local"
if (!(Test-Path $envLocal)) {
  Copy-Item (Join-Path $repoRoot ".env.example") $envLocal
  Write-Host "[setup] Created .env.local from .env.example."
} else {
  Write-Host "[setup] Existing .env.local kept unchanged."
}

Write-Host ""
Write-Host "Setup complete."
Write-Host "1. Edit .env.local and fill in your own keys."
Write-Host "2. Start with: powershell -ExecutionPolicy Bypass -File .\scripts\run-demo.ps1"
