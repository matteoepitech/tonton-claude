# Tonton Claude agent, Windows. Published with each release:
#   $env:TONTON_ENROLL='<code>'; irm https://github.com/matteoepitech/tonton-claude/releases/latest/download/install.ps1 | iex
# TONTON_ENROLL is the connection code from the app (Machines > Add machine). Without it, an enrolled machine updates.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'matteoepitech/tonton-claude'
$Version = '__VERSION__'

if (-not $env:TONTON_ENROLL -and -not (Test-Path (Join-Path $HOME '.tonton\config.json'))) {
  throw 'Missing TONTON_ENROLL. Copy the install command from Tonton Claude > Machines > Add machine.'
}

# The claude launcher lives in the PowerShell profile, which only loads if scripts are allowed.
if ((Get-ExecutionPolicy) -in @('Restricted', 'AllSigned', 'Undefined')) {
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
  Write-Host 'PowerShell execution policy set to RemoteSigned (current user).'
}

$release = "https://github.com/$Repo/releases/download/v$Version"
$name = 'tonton-windows-x64.exe'
$dir = Join-Path $HOME '.tonton\bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'tonton.exe'
$download = "$exe.download"

Write-Host "Downloading Tonton Claude $Version (windows-x64)..."
$sums = (Invoke-WebRequest -UseBasicParsing "$release/SHA256SUMS").Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
$expected = ($sums -split "`n" | Where-Object { $_ -match "  $([regex]::Escape($name))\s*$" } | ForEach-Object { ($_ -split ' ')[0] })
Invoke-WebRequest -UseBasicParsing "$release/$name" -OutFile $download
if (-not $expected -or (Get-FileHash -Algorithm SHA256 $download).Hash -ne $expected.ToUpper()) {
  Remove-Item -Force $download
  throw "$name does not match its checksum, aborting."
}
# A running exe can't be overwritten on Windows, but it can be renamed.
if (Test-Path $exe) { Move-Item -Force $exe "$exe.old-$([DateTime]::Now.Ticks)" }
Move-Item -Force $download $exe
try { & $exe install } finally { Remove-Item Env:TONTON_ENROLL -ErrorAction SilentlyContinue }
