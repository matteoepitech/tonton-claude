// Types in a tmux server of its own, running `cat`: never the developer's tmux or claude.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionCommand } from '../../shared/protocol'
import { runCommand, type TerminalPane, terminalOf, whyBusy } from '../src/channel/terminal'

const dir = mkdtempSync(join(tmpdir(), 'tonton-terminal-'))
const socket = join(dir, 'tmux.sock')
const hasTmux = process.platform !== 'win32' && Bun.spawnSync(['tmux', '-V']).exitCode === 0

afterAll(() => {
  if (hasTmux) Bun.spawnSync(['tmux', '-S', socket, 'kill-server'])
  rmSync(dir, { recursive: true, force: true })
})

let ids = 0
const command = (fields: Partial<SessionCommand> = {}): SessionCommand => ({
  name: 'compact',
  sessionId: 's1',
  id: `command-${++ids}-${Date.now()}`,
  issuedAt: new Date().toISOString(),
  ...fields,
})
const pane: TerminalPane = { socket: '/tmp/fake', pane: '%1' }

/** Plays tmux: shows `screen`, records what is typed. */
function fakeTmux(screen = '> \n  ? for shortcuts') {
  const typed: string[][] = []
  return {
    typed,
    tmux: (_: TerminalPane, args: string[]) => {
      if (args[0] === 'send-keys') typed.push(args.slice(3))
      return { ok: true, output: args[0] === 'capture-pane' ? screen : '' }
    },
  }
}

describe('terminalOf', () => {
  test('the server and pane from the environment tmux sets', () => {
    expect(terminalOf({ TMUX: '/tmp/tmux-501/default,4242,0', TMUX_PANE: '%3' })).toEqual({ socket: '/tmp/tmux-501/default', pane: '%3' })
    expect(terminalOf({ TMUX_PANE: '%3' })).toBeNull()
    expect(terminalOf({ TMUX: '/tmp/tmux-501/default,4242,0', TMUX_PANE: 'main:0' })).toBeNull()
    expect(terminalOf({})).toBeNull()
  })
})

describe('runCommand', () => {
  test('types the command, then Enter, once', () => {
    const fake = fakeTmux()
    const sent = command()
    expect(runCommand(sent, 's1', pane, { run: dir, tmux: fake.tmux })).toEqual({ typed: true })
    expect(fake.typed).toEqual([['-l', '/compact'], ['Enter']])
    // The relay replays it: nothing is typed, and nothing is said.
    expect(runCommand(sent, 's1', pane, { run: dir, tmux: fake.tmux })).toEqual({ typed: false, why: null })
    expect(fake.typed).toHaveLength(2)
  })

  test('switches the model to one of the aliases', () => {
    const fake = fakeTmux()
    expect(runCommand(command({ name: 'model', model: 'haiku' }), 's1', pane, { run: dir, tmux: fake.tmux })).toEqual({ typed: true })
    expect(fake.typed).toEqual([['-l', '/model haiku'], ['Enter']])
  })

  test('refuses commands for another session, unknown, expired, with odd ids, or for a session outside tmux', () => {
    const fake = fakeTmux()
    const refused = (sent: SessionCommand, terminal: TerminalPane | null = pane) => {
      const result = runCommand(sent, 's1', terminal, { run: dir, tmux: fake.tmux })
      return result.typed ? null : result.why
    }
    expect(refused(command({ sessionId: 's2' }))).toBe('The command is not for this session.')
    expect(refused(command({ name: 'login' as SessionCommand['name'] }))).toBe('The command is not for this session.')
    expect(refused(command({ id: '../../config' }))).toBe('The command is not for this session.')
    // Only `/model` takes a model, and only one of the aliases: nothing else from the relay is typed.
    expect(refused(command({ name: 'model' }))).toBe('The command is not for this session.')
    expect(refused(command({ name: 'model', model: 'opus; rm -rf ~' as SessionCommand['model'] }))).toBe(
      'The command is not for this session.',
    )
    expect(refused(command({ name: 'clear', model: 'opus' }))).toBe('The command is not for this session.')
    expect(refused(command({ issuedAt: '2020-01-01T00:00:00Z' }))).toContain('expired')
    expect(refused(command(), null)).toContain('does not run in tmux')
    expect(fake.typed).toEqual([])
  })

  test('waits for Claude to be at its prompt', () => {
    for (const screen of ['✻ Compacting… (esc to interrupt)', ' Do you want to proceed?\n ❯ 1. Yes\n   2. No']) {
      const fake = fakeTmux(screen)
      const result = runCommand(command(), 's1', pane, { run: dir, tmux: fake.tmux })
      expect(result.typed).toBe(false)
      expect(fake.typed).toEqual([])
    }
  })
})

describe('interrupt', () => {
  test('presses Escape while Claude works, once', () => {
    const fake = fakeTmux('· Thinking… (12s · esc to interrupt)')
    const sent = command({ name: 'interrupt' })
    expect(runCommand(sent, 's1', pane, { run: dir, tmux: fake.tmux })).toEqual({ typed: true })
    expect(fake.typed).toEqual([['Escape']])
    expect(runCommand(sent, 's1', pane, { run: dir, tmux: fake.tmux })).toEqual({ typed: false, why: null })
    expect(fake.typed).toHaveLength(1)
  })
})

describe('whyBusy', () => {
  test('a prompt waiting for input is free, a running turn or a choice is not', () => {
    expect(whyBusy('╭───╮\n│ > │\n╰───╯\n  ? for shortcuts')).toBeNull()
    expect(whyBusy('> 1. is a fine start for a list')).toBeNull()
    expect(whyBusy('· Thinking… (12s · esc to interrupt)')).toContain('working')
    expect(whyBusy('│ ❯ 1. Yes, I trust this folder')).toContain('asking')
    expect(whyBusy('   1. Yes\n ❯ 2. No, and tell Claude what to do differently')).toContain('asking')
  })
})

describe.skipIf(!hasTmux)('in a real tmux', () => {
  test('the command reaches the program in the pane', async () => {
    const env = { ...process.env, TMUX: undefined } as Record<string, string | undefined>
    Bun.spawnSync(['tmux', '-S', socket, '-f', '/dev/null', 'new-session', '-d', '-x', '80', '-y', '20', 'cat'], { env })
    const id = Bun.spawnSync(['tmux', '-S', socket, 'display-message', '-p', '#{pane_id}'], { env }).stdout.toString().trim()
    expect(runCommand(command({ name: 'clear' }), 's1', { socket, pane: id }, { run: dir })).toEqual({ typed: true })
    let screen = ''
    for (let i = 0; i < 40 && !screen.includes('/clear\n/clear'); i++) {
      await Bun.sleep(50)
      screen = Bun.spawnSync(['tmux', '-S', socket, 'capture-pane', '-p', '-t', id], { env }).stdout.toString()
    }
    // The terminal echoes the line, then cat prints it back once Enter sent it.
    expect(screen).toContain('/clear\n/clear')
  })
})
