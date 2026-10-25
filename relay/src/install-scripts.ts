// One-liner install scripts. They contain no secret: the enrollment code and the end-to-end key come from the
// TONTON_ENROLL variable set in the command the Mac app gives you. Without it, an enrolled machine just updates.

const quoteSh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const quotePs = (s: string) => `'${s.replace(/'/g, "''")}'`

export function installSh(server: string): string {
  return `#!/bin/sh
# Tonton Claude - macOS / Linux install
set -e
SERVER=${quoteSh(server)}

if [ -z "$TONTON_ENROLL" ] && [ ! -f "$HOME/.tonton/config.json" ]; then
  echo "Missing TONTON_ENROLL. Copy the install command from Tonton Claude > Machines > Add machine." >&2
  exit 1
fi

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac
case "$os" in
  darwin|linux) ;;
  *) echo "Unsupported OS: $os (on Windows, use install.ps1)" >&2; exit 1 ;;
esac

dir="$HOME/.tonton/bin"
mkdir -p "$dir"
echo "Downloading tonton ($os-$arch)..."
curl -fsSL "$SERVER/dl/tonton-$os-$arch" -o "$dir/tonton.tmp"
chmod +x "$dir/tonton.tmp"
mv -f "$dir/tonton.tmp" "$dir/tonton"
"$dir/tonton" install --server "$SERVER" "$@"
`
}

export function installPs1(server: string): string {
  return `# Tonton Claude - Windows install
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Server = ${quotePs(server)}

if (-not $env:TONTON_ENROLL -and -not (Test-Path (Join-Path $HOME '.tonton\\config.json'))) {
  throw 'Missing TONTON_ENROLL. Copy the install command from Tonton Claude > Machines > Add machine.'
}

# The claude launcher lives in the PowerShell profile, which only loads if scripts are allowed.
if ((Get-ExecutionPolicy) -in @('Restricted', 'AllSigned', 'Undefined')) {
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
  Write-Host 'PowerShell execution policy set to RemoteSigned (current user).'
}

$dir = Join-Path $HOME '.tonton\\bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'tonton.exe'
Write-Host 'Downloading tonton (windows-x64)...'
Invoke-WebRequest -UseBasicParsing "$Server/dl/tonton-windows-x64.exe" -OutFile "$exe.tmp"
# A running exe can't be overwritten on Windows, but it can be renamed.
if (Test-Path $exe) { Move-Item -Force $exe "$exe.old-$([DateTime]::Now.Ticks)" }
Move-Item -Force "$exe.tmp" $exe
try { & $exe install --server $Server } finally { Remove-Item Env:TONTON_ENROLL -ErrorAction SilentlyContinue }
`
}
