import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_EVENTS, launcherSettings, withoutTontonHooks, withTontonHooks } from '../src/install/claude-settings'
import { installOpenCodePlugin, openCodeConfigDir, removeOpenCodePlugin } from '../src/install/opencode'
import { launcherBlock, removeLauncher, withLauncher } from '../src/install/shell-profile'

const BINARY = '/home/user/.tonton/bin/tonton'
const SETTINGS = '/home/user/.tonton/claude-settings.json'

describe('Claude settings', () => {
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/audit' }] }

  test('adds one hook per event and keeps unrelated settings and hooks', () => {
    const settings = withTontonHooks({ model: 'opus', hooks: { PreToolUse: [userHook] } }, BINARY)
    expect(settings.model).toBe('opus')
    expect(settings.hooks?.PreToolUse).toEqual([userHook])
    for (const event of HOOK_EVENTS) expect(settings.hooks?.[event]).toHaveLength(1)
  })

  test('is idempotent', () => {
    const once = withTontonHooks({}, BINARY)
    expect(withTontonHooks(once, BINARY)).toEqual(once)
  })

  test('removal leaves the user hooks only', () => {
    const settings = withTontonHooks({ hooks: { Stop: [userHook] } }, BINARY)
    expect(withoutTontonHooks(settings)).toEqual({ hooks: { Stop: [userHook] } })
    expect(withoutTontonHooks(withTontonHooks({}, BINARY))).toEqual({})
  })
})

describe('shell launcher', () => {
  test('installing twice gives the same profile, removal restores it', () => {
    const profile = 'export PATH="$HOME/bin:$PATH"\n'
    const once = withLauncher(profile, 'posix', SETTINGS)
    expect(withLauncher(once, 'posix', SETTINGS)).toBe(once)
    expect(removeLauncher(once).trim()).toBe(profile.trim())
  })

  test('posix and PowerShell launchers both pass the channel flag', () => {
    expect(launcherBlock('posix', SETTINGS)).toContain(
      'TONTON_CHANNEL=1 command claude --dangerously-load-development-channels server:tonton',
    )
    expect(launcherBlock('powershell', SETTINGS)).toContain("$env:TONTON_CHANNEL = '1'")
  })

  test('they add the settings file only when it exists, quoted for each shell', () => {
    expect(launcherBlock('posix', "/home/o'neil/.tonton/s.json")).toContain(
      `[ -f '/home/o'\\''neil/.tonton/s.json' ] && set -- --settings '/home/o'\\''neil/.tonton/s.json' "$@"`,
    )
    const powershell = launcherBlock('powershell', "C:\\Users\\o'neil\\.tonton\\s.json")
    expect(powershell).toContain("Test-Path -LiteralPath 'C:\\Users\\o''neil\\.tonton\\s.json'")
    expect(powershell).toContain('server:tonton @settings @args')
  })
})

describe('launcher settings', () => {
  const command = (binary: string, home: string, windows: boolean) =>
    (launcherSettings(binary, home, windows).statusLine as { command: string }).command

  test('the status line runs this binary', () => {
    expect(launcherSettings(BINARY, '/home/user', false)).toEqual({
      statusLine: { type: 'command', command: "'/home/user/.tonton/bin/tonton' statusline" },
    })
  })

  test('on Windows the path works in Git Bash and PowerShell alike', () => {
    expect(command('C:\\Users\\Jean Dupont\\.tonton\\bin\\tonton.exe', 'C:\\Users\\Jean Dupont', true)).toBe(
      '~/.tonton/bin/tonton.exe statusline',
    )
    expect(command('D:\\tools\\tonton.exe', 'C:\\Users\\jean', true)).toBe('D:/tools/tonton.exe statusline')
  })
})

describe('OpenCode plugin', () => {
  test('lives in the global configuration folder, which XDG_CONFIG_HOME moves', () => {
    expect(openCodeConfigDir({}, '/home/user')).toBe(join('/home/user', '.config', 'opencode'))
    expect(openCodeConfigDir({ XDG_CONFIG_HOME: '/xdg' }, '/home/user')).toBe(join('/xdg', 'opencode'))
  })

  test('is written next to the user plugins with the installed binary, and removed alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tonton-opencode-config-'))
    try {
      const file = installOpenCodePlugin(BINARY, dir)
      expect(file).toBe(join(dir, 'plugins', 'tonton-claude.js'))
      expect(readFileSync(file, 'utf8')).toContain(JSON.stringify([BINARY, 'opencode']))
      removeOpenCodePlugin(dir)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(join(dir, 'plugins'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
