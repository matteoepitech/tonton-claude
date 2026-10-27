// The `claude` launcher written into shell profiles: it starts Claude Code with the Tonton Claude channel and settings
// (its status line, see statusline.ts), except for subcommands and non-interactive runs.

/** Opens the launcher's block: a profile with it has a launcher, maybe from an older install. */
export const BEGIN = '# >>> tonton >>>'
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

/** `settings` is the file passed with --settings, skipped when it is missing so claude always starts. */
export function launcherBlock(shell: Shell, settings: string): string {
  const body = shell === 'posix' ? posixLauncher(settings) : powershellLauncher(settings)
  return `${BEGIN}\n# Starts claude with the Tonton Claude channel, so the session can be driven from the Mac notch.\n${body}\n${END}`
}

export function removeLauncher(profile: string): string {
  return profile.replace(new RegExp(`\\n?${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}\\n?`, 'g'), '\n').replace(/\n{3,}/g, '\n\n')
}

/** Replaces any previous launcher, so running the installer twice changes nothing. */
export function withLauncher(profile: string, shell: Shell, settings: string): string {
  const base = removeLauncher(profile).replace(/\s*$/, '')
  return `${base ? `${base}\n\n` : ''}${launcherBlock(shell, settings)}\n`
}

function posixLauncher(settings: string): string {
  const file = `'${settings.replace(/'/g, `'\\''`)}'`
  return `claude() {
  case "\${1:-}" in
    ${SUBCOMMANDS.join('|')}) command claude "$@"; return ;;
  esac
  for arg in "$@"; do
    case "$arg" in ${PASSTHROUGH_FLAGS.join('|')}) command claude "$@"; return ;; esac
  done
  [ -f ${file} ] && set -- --settings ${file} "$@"
  TONTON_CHANNEL=1 command claude ${CHANNEL_FLAGS} "$@"
}`
}

function powershellLauncher(settings: string): string {
  const quote = (item: string) => `'${item.replace(/'/g, "''")}'`
  const list = (items: string[]) => items.map(quote).join(', ')
  const file = quote(settings)
  return `function claude {
  $real = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $real) { Write-Error 'claude not found in PATH'; return }
  $subcommands = @(${list(SUBCOMMANDS)})
  $passthrough = @(${list(PASSTHROUGH_FLAGS)})
  if (($args.Count -gt 0 -and $subcommands -contains $args[0]) -or ($args | Where-Object { $passthrough -contains $_ })) {
    & $real.Source @args
    return
  }
  $settings = if (Test-Path -LiteralPath ${file}) { @('--settings', ${file}) } else { @() }
  $env:TONTON_CHANNEL = '1'
  try { & $real.Source ${CHANNEL_FLAGS} @settings @args }
  finally { Remove-Item Env:TONTON_CHANNEL -ErrorAction SilentlyContinue }
}`
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
