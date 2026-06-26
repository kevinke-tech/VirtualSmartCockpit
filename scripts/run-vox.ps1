$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$voxRoot = Resolve-Path (Join-Path $repoRoot "..\claudeCode\vox")
$venvRoot = Join-Path $voxRoot ".venv-win"
$py = Join-Path $venvRoot "Scripts\python.exe"

if (Test-Path $py) {
  $maj = (& $py -c "import sys; print(sys.version_info[0])")
  $min = (& $py -c "import sys; print(sys.version_info[1])")
  if (("$maj.$min") -ne "3.12") {
    Remove-Item -Recurse -Force $venvRoot -ErrorAction SilentlyContinue
  }
}

if (!(Test-Path $py)) {
  py -3.12 -m venv $venvRoot
}

$py = Join-Path $venvRoot "Scripts\python.exe"
$needInstall = $true
if (Test-Path $py) {
  & $py -c "import httpx, claude_agent_sdk" 2>$null
  if ($LASTEXITCODE -eq 0) {
    $needInstall = $false
  }
}

if ($needInstall) {
  & $py -m pip install -U pip
  & $py -m pip install -r (Join-Path $voxRoot "requirements.txt")
  & $py -m pip install claude-agent-sdk
}

Set-Location $voxRoot
& $py server.py
