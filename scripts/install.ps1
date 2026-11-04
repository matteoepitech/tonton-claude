# Tonton Claude agent, Windows. Published with each release:
#   $env:TONTON_TOKEN='<token>'; irm https://github.com/matteoepitech/tonton-claude/releases/latest/download/install.ps1 | iex
# TONTON_TOKEN is the token from the app (Machines). Without it, a connected machine updates.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'matteoepitech/tonton-claude'
$Version = '__VERSION__'

if (-not $env:TONTON_TOKEN -and -not (Test-Path (Join-Path $HOME '.tonton\config.json'))) {
  throw 'Missing TONTON_TOKEN. Copy the install command from Tonton Claude > Machines.'
}

# The claude launcher lives in the PowerShell profiles, which only load if scripts are allowed. A Group Policy wins over
# the user's policy and makes setting it fail: the install goes on, with a warning.
$closed = @('Restricted', 'AllSigned', 'Undefined')
$blocked = 'Scripts stay disabled in {0}, maybe by a Group Policy: claude started from it will not reach Tonton.'
try {
  if ((Get-ExecutionPolicy) -in $closed) {
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
    Write-Host 'PowerShell execution policy set to RemoteSigned (current user).'
  }
} catch { Write-Warning ($blocked -f 'PowerShell') }
# PowerShell 7 allows scripts by default, but the launcher goes to the profile of Windows PowerShell too, which has its own
# policy and is the default terminal of VS Code and Rider.
if ($PSVersionTable.PSEdition -eq 'Core' -and (Get-Command powershell.exe -ErrorAction SilentlyContinue)) {
  try {
    if ((powershell.exe -NoProfile -Command 'Get-ExecutionPolicy') -in $closed) {
      powershell.exe -NoProfile -Command 'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force' 2>$null
      if ($LASTEXITCODE -ne 0) { throw 'Set-ExecutionPolicy failed' }
      Write-Host 'Windows PowerShell execution policy set to RemoteSigned (current user).'
    }
  } catch { Write-Warning ($blocked -f 'Windows PowerShell') }
}

$release = "https://github.com/$Repo/releases/download/v$Version"
$name = 'tonton-windows-x64.exe'
$dir = Join-Path $HOME '.tonton\bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'tonton.exe'
$download = "$exe.download"

# Windows PowerShell 5.1 ignores HTTPS_PROXY, which curl, PowerShell 7 and the agent all read: only 5.1 gets -Proxy, and
# PowerShell 7 keeps its own handling, with passwords and NO_PROXY. -Proxy drops a user and password in the URL, so they
# go in -ProxyCredential. NO_PROXY is not read for 5.1: every download goes to GitHub.
$web = @{ UseBasicParsing = $true }
$proxy = @($env:HTTPS_PROXY, $env:ALL_PROXY) | Where-Object { $_ } | Select-Object -First 1
if ($proxy -and $PSVersionTable.PSEdition -ne 'Core') {
  $uri = [Uri]$(if ($proxy -match '://') { $proxy } else { "http://$proxy" })
  $web.Proxy = "$($uri.Scheme)://$($uri.Authority)"
  if ($uri.UserInfo) {
    $user, $password = $uri.UserInfo -split ':', 2 | ForEach-Object { [Uri]::UnescapeDataString($_) }
    $web.ProxyCredential = New-Object PSCredential($user, (New-Object Net.NetworkCredential($user, "$password")).SecurePassword)
  }
}

Write-Host "Downloading Tonton Claude $Version (windows-x64)..."
$sums = (Invoke-WebRequest @web "$release/SHA256SUMS").Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
$expected = ($sums -split "`n" | Where-Object { $_ -match "  $([regex]::Escape($name))\s*$" } | ForEach-Object { ($_ -split ' ')[0] })
Invoke-WebRequest @web "$release/$name" -OutFile $download
if (-not $expected -or (Get-FileHash -Algorithm SHA256 $download).Hash -ne $expected.ToUpper()) {
  Remove-Item -Force $download
  throw "$name does not match its checksum, aborting."
}
# A running exe can't be overwritten on Windows, but it can be renamed.
if (Test-Path $exe) { Move-Item -Force $exe "$exe.old-$([DateTime]::Now.Ticks)" }
Move-Item -Force $download $exe
try { & $exe install } finally { Remove-Item Env:TONTON_TOKEN -ErrorAction SilentlyContinue }
