import { describe, expect, test } from 'bun:test'
import { HOOK_EVENTS, withoutTontonHooks, withTontonHooks } from '../src/install/claude-settings'
import { launcherBlock, removeLauncher, withLauncher } from '../src/install/shell-profile'

const BINARY = '/home/user/.tonton/bin/tonton'

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
    const once = withLauncher(profile, 'posix')
    expect(withLauncher(once, 'posix')).toBe(once)
    expect(removeLauncher(once).trim()).toBe(profile.trim())
  })

  test('posix and PowerShell launchers both pass the channel flag', () => {
    expect(launcherBlock('posix')).toContain('TONTON_CHANNEL=1 command claude --dangerously-load-development-channels server:tonton')
    expect(launcherBlock('powershell')).toContain("$env:TONTON_CHANNEL = '1'")
  })
})
