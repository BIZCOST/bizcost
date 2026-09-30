# Starts Docker Desktop for local development (Windows).
#
# After an unclean stop (disk full, crash, power loss) Docker Desktop can refuse to start because stale
# AF_UNIX socket files are left in %LOCALAPPDATA%\Docker\run and %LOCALAPPDATA%\docker-secrets-engine.
# Windows cannot delete those files, so this script moves the two folders aside (Docker recreates them)
# before starting. It never touches Docker's data disk, images or volumes, and never "resets" Docker.
# Usage: pnpm docker:start

$ErrorActionPreference = 'Stop'
$dockerExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$dockerCli = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'

function Test-Engine {
  # Windows PowerShell 5.1 turns a native command's stderr into an error record; with 'Stop' above,
  # "engine not running" would end the script instead of answering false.
  $ErrorActionPreference = 'Continue'
  & $dockerCli info *> $null
  return $LASTEXITCODE -eq 0
}

if (Test-Engine) {
  Write-Host 'Docker is already running.'
  exit 0
}

Get-Process 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue |
  Stop-Process -Force -Confirm:$false -ErrorAction SilentlyContinue

$stamp = Get-Date -Format yyyyMMddHHmmss
foreach ($dir in @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")) {
  if (Test-Path -LiteralPath $dir) {
    Rename-Item -LiteralPath $dir -NewName ((Split-Path $dir -Leaf) + ".stale-$stamp")
    Write-Host "Moved aside stale sockets: $dir"
  }
}

wsl.exe --shutdown
Start-Process $dockerExe
Write-Host 'Starting Docker Desktop...'

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 5
  if (Test-Engine) {
    Write-Host 'Docker is running. The local Supabase containers start by themselves.'
    exit 0
  }
}
Write-Error 'Docker did not start within 5 minutes. Open Docker Desktop to see its message.'
