import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_EVENTS, launcherSettings, type WindowsShell, withoutTontonHooks, withTontonHooks } from '../src/install/claude-settings'
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
  const command = (binary: string, home: string, windows: boolean, shell: Partial<WindowsShell> = {}) =>
    (launcherSettings(binary, home, windows, () => ({ env: {}, gitBash: true, ...shell })).statusLine as { command: string }).command

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

  const JEAN = 'C:\\Users\\Jean Dupont\\.tonton\\bin\\tonton.exe'
  const powershell = { gitBash: false }

  test('a path without spaces is written whole, so neither HOME nor a home drive moves it', () => {
    for (const env of [{}, { HOME: 'H:\\' }, { HOMEDRIVE: 'H:', HOMEPATH: '\\' }])
      expect(command('C:\\Users\\Jérôme\\.tonton\\bin\\tonton.exe', 'C:\\Users\\Jérôme', true, { env })).toBe(
        'C:/Users/Jérôme/.tonton/bin/tonton.exe statusline',
      )
  })

  test('~ only when it is the user folder, however HOME spells it', () => {
    for (const HOME of ['C:\\Users\\Jean Dupont', 'c:/users/jean dupont/', '/c/Users/Jean Dupont'])
      expect(command(JEAN, 'C:\\Users\\Jean Dupont', true, { env: { HOME } })).toBe('~/.tonton/bin/tonton.exe statusline')
    const env = { HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\Jean Dupont' }
    expect(command(JEAN, 'C:\\Users\\Jean Dupont', true, { env })).toBe('~/.tonton/bin/tonton.exe statusline')
  })

  test('with HOME or the home drive elsewhere, the full path quoted for the shell Claude Code uses', () => {
    for (const env of [{ HOME: 'H:\\' }, { HOMEDRIVE: 'H:', HOMEPATH: '\\' }]) {
      expect(command(JEAN, 'C:\\Users\\Jean Dupont', true, { env })).toBe('"C:/Users/Jean Dupont/.tonton/bin/tonton.exe" statusline')
      expect(command(JEAN, 'C:\\Users\\Jean Dupont', true, { env, ...powershell })).toBe(
        "& 'C:\\Users\\Jean Dupont\\.tonton\\bin\\tonton.exe' statusline",
      )
    }
  })

  test('a path with spaces outside the home runs in PowerShell too', () => {
    const binary = 'C:\\Program Files\\Tonton\\tonton.exe'
    expect(command(binary, 'C:\\Users\\jean', true)).toBe('"C:/Program Files/Tonton/tonton.exe" statusline')
    expect(command(binary, 'C:\\Users\\jean', true, powershell)).toBe("& 'C:\\Program Files\\Tonton\\tonton.exe' statusline")
  })

  test('quotes and dollars in the path stay literal in each shell', () => {
    const binary = "D:\\O'Neil $x`\u2019s\\tonton.exe"
    expect(command(binary, 'C:\\Users\\jean', true)).toBe(`"D:/O'Neil \\$x\\\`\u2019s/tonton.exe" statusline`)
    expect(command(binary, 'C:\\Users\\jean', true, powershell)).toBe(`& 'D:\\O''Neil $x\`\u2019\u2019s\\tonton.exe' statusline`)
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
