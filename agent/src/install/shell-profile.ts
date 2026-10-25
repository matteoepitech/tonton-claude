// The `claude` launcher written into shell profiles: it starts Claude Code with the Tonton Claude channel,
// except for subcommands and non-interactive runs.

const BEGIN = '# >>> tonton >>>'
const END = '# <<< tonton <<<'

const SUBCOMMANDS = [
  'mcp',
  'config',
  'plugin',
  'plugins',
  'update',
  'upgrade',
  'doctor',
  'install',
  'remote-control',
  'rc',
  'setup-token',
  'auth',
  'login',
  'logout',
  'agents',
  'migrate-installer',
  'api-key',
]
const PASSTHROUGH_FLAGS = ['-p', '--print', '-v', '--version', '-h', '--help']
const CHANNEL_FLAGS = '--dangerously-load-development-channels server:tonton'

export type Shell = 'posix' | 'powershell'

export function launcherBlock(shell: Shell): string {
  const body = shell === 'posix' ? posixLauncher() : powershellLauncher()
  return `${BEGIN}\n# Starts claude with the Tonton Claude channel, so the session can be driven from the Mac notch.\n${body}\n${END}`
}

export function removeLauncher(profile: string): string {
  return profile.replace(new RegExp(`\\n?${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}\\n?`, 'g'), '\n').replace(/\n{3,}/g, '\n\n')
}

/** Replaces any previous launcher, so running the installer twice changes nothing. */
export function withLauncher(profile: string, shell: Shell): string {
  const base = removeLauncher(profile).replace(/\s*$/, '')
  return `${base ? `${base}\n\n` : ''}${launcherBlock(shell)}\n`
}

function posixLauncher(): string {
  return `claude() {
  case "\${1:-}" in
    ${SUBCOMMANDS.join('|')}) command claude "$@"; return ;;
  esac
  for arg in "$@"; do
    case "$arg" in ${PASSTHROUGH_FLAGS.join('|')}) command claude "$@"; return ;; esac
  done
  TONTON_CHANNEL=1 command claude ${CHANNEL_FLAGS} "$@"
}`
}

function powershellLauncher(): string {
  const list = (items: string[]) => items.map(item => `'${item}'`).join(', ')
  return `function claude {
  $real = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $real) { Write-Error 'claude not found in PATH'; return }
  $subcommands = @(${list(SUBCOMMANDS)})
  $passthrough = @(${list(PASSTHROUGH_FLAGS)})
  if (($args.Count -gt 0 -and $subcommands -contains $args[0]) -or ($args | Where-Object { $passthrough -contains $_ })) {
    & $real.Source @args
    return
  }
  $env:TONTON_CHANNEL = '1'
  try { & $real.Source ${CHANNEL_FLAGS} @args }
  finally { Remove-Item Env:TONTON_CHANNEL -ErrorAction SilentlyContinue }
}`
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
