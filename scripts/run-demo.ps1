$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (Test-Path ".venv\Scripts\Activate.ps1") {
  . ".venv\Scripts\Activate.ps1"
} elseif (Test-Path "..\vui\.venv\Scripts\Activate.ps1") {
  . "..\vui\.venv\Scripts\Activate.ps1"
} elseif (Test-Path "venv\Scripts\Activate.ps1") {
  . "venv\Scripts\Activate.ps1"
}

python server.py
