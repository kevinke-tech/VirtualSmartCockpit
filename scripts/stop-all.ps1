$ports = @(5002, 5001)

foreach ($port in $ports) {
  $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  if ($pids) {
    $pids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Write-Host "Stopped listener on port $port."
  } else {
    Write-Host "No listener on port $port."
  }
}

Write-Host "Cockpit (5002) + VOX (5001) stop command finished."
