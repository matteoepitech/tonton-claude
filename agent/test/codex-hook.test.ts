// `tonton hook codex` as Codex runs it, through a shell with `exec`: it links the session for the channel of the same
// codex process and tells the relay its status, the text of a permission request sealed. Codex's hook input has the
// fields of codex-rs/hooks/src/schema.rs.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newAccountKey, open } from '../../shared/crypto'
import type { HookPost } from '../../shared/protocol'
import { holdPoolPost } from '../src/channel/pool-held'
import { approveByRule, type CodexHookInput, codexPid, codexStatus, link } from '../src/codex/hook'

const AGENT = join(import.meta.dir, '../src/main.ts')
const dir = mkdtempSync(join(tmpdir(), 'tonton-codex-hook-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SESSION = '01a2b3c4-5d6e-7f80-91a2-b3c4d5e6f708'
const ROLLOUT = '/codex/sessions/2026/11/04/rollout-2026-11-04T10-00-00-01a2b3c4-5d6e-7f80-91a2-b3c4d5e6f708.jsonl'
const input = (hook_event_name: string, fields: Partial<CodexHookInput> = {}): CodexHookInput => ({
  hook_event_name,
  session_id: SESSION,
  turn_id: 'turn-1',
  transcript_path: ROLLOUT,
  cwd: '/work/hero',
  model: 'gpt-5.5',
  permission_mode: 'default',
  ...fields,
})

describe('the status of each event', () => {
  test('as the Claude Code hook event that means the same', () => {
    const status = (name: string, fields: Partial<CodexHookInput> = {}, previous?: string) => codexStatus(input(name, fields), previous)
    expect(status('SessionStart', { source: 'startup' })?.event.hook_event_name).toBe('SessionStart')
    expect(status('SessionStart', { source: 'compact' })).toBeNull()
    expect(status('UserPromptSubmit')?.event.hook_event_name).toBe('UserPromptSubmit')
    expect(status('Stop', { stop_hook_active: false })?.event.hook_event_name).toBe('Stop')
    expect(status('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' } })).toEqual({
      event: { hook_event_name: 'Notification', session_id: SESSION, notification_type: 'permission_prompt' },
      text: 'Codex needs your permission to use Bash',
    })
    expect(status('PermissionRequest', { tool_name: 'apply_patch' })?.text).toBe('Codex needs your permission to use Edit')
    expect(status('PermissionRequest', { tool_name: 'mcp__github__create_issue' })?.text).toBe(
      'Codex needs your permission to use mcp__github__create_issue',
    )
    // Answered: the next tool hook of the turn says it goes on. Otherwise tool hooks change nothing.
    expect(status('PostToolUse', {}, 'PermissionRequest')?.event.hook_event_name).toBe('UserPromptSubmit')
    expect(status('PreToolUse', {}, 'PermissionRequest')?.event.hook_event_name).toBe('UserPromptSubmit')
    expect(status('PostToolUse', {}, 'UserPromptSubmit')).toBeNull()
    expect(status('PreCompact')).toBeNull()
  })

  test("the link keeps its session's rollout through a subagent's calls, and says whether Codex is in a turn", () => {
    const first = link(input('SessionStart', { source: 'startup' }), null)
    expect(first).toMatchObject({ sessionId: SESSION, transcriptPath: ROLLOUT, cwd: '/work/hero', tool: 'codex', event: 'SessionStart' })
    const prompt = link(input('UserPromptSubmit'), first)
    expect(prompt.event).toBe('UserPromptSubmit')
    const asked = link(input('PermissionRequest', { tool_name: 'Bash' }), prompt)
    expect(asked.event).toBe('PermissionRequest')
    expect(link(input('PostToolUse'), asked).event).toBe('UserPromptSubmit')
    const subagent = link(
      input('PreToolUse', { agent_id: 'agent-1', transcript_path: '/codex/sessions/sub.jsonl', cwd: '/elsewhere' }),
      prompt,
    )
    expect(subagent).toMatchObject({ transcriptPath: ROLLOUT, cwd: '/work/hero', event: 'UserPromptSubmit' })
    // A subagent's calls while its parent waits for the user end no turn and start none.
    const stopped = link(input('Stop'), prompt)
    expect(link(input('PostToolUse', { agent_id: 'agent-1' }), stopped).event).toBe('Stop')
    // A new thread in the same codex: the link follows it, without the old rollout.
    expect(link(input('SessionStart', { session_id: 'other', transcript_path: null, source: 'clear' }), prompt)).toMatchObject({
      sessionId: 'other',
      transcriptPath: null,
    })
    expect(link(input('UserPromptSubmit', { permission_mode: 'bypassPermissions' }), prompt).permissionMode).toBe('bypassPermissions')
  })
})

describe('auto-approve rules', () => {
  const rules = [
    { tool: 'Bash', pattern: 'npm test' },
    { tool: 'Edit', pattern: '' },
  ]
  const ask = (tool_name: string, tool_input: unknown): CodexHookInput => ({
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    tool_name,
    tool_input,
  })

  test("approve what they match, in Codex's names, and let the user answer the rest", () => {
    const write = process.stdout.write
    const printed: string[] = []
    process.stdout.write = ((chunk: string) => printed.push(chunk) > 0) as typeof process.stdout.write
    try {
      expect(approveByRule(ask('exec_command', { cmd: 'npm test' }), rules)).toBe(true)
      expect(approveByRule(ask('Bash', { command: ['bash', '-lc', 'npm test'] }), rules)).toBe(true)
      expect(approveByRule(ask('exec_command', { cmd: 'npm test && rm -rf ~' }), rules)).toBe(false)
      expect(approveByRule(ask('exec_command', {}), rules)).toBe(false)
      expect(approveByRule(ask('apply_patch', { input: '*** Begin Patch' }), rules)).toBe(true)
      expect(approveByRule(ask('web_search', {}), rules)).toBe(false)
    } finally {
      process.stdout.write = write
    }
    expect(printed).toHaveLength(3)
    expect(JSON.parse(printed[0] ?? '')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
  })

  test('on a pool machine, its mode lets a patch in the worktree through, and `full` everything; the rest asks', () => {
    const write = process.stdout.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    const patch = (...files: string[]) =>
      ['*** Begin Patch', ...files.flatMap(file => [`*** Add File: ${file}`, '+done']), '*** End Patch'].join('\n')
    const inTree = (tool_input: unknown) => ({ ...ask('apply_patch', tool_input), cwd: '/work/tree' })
    const edits = { mode: 'edits' as const, root: '/work/tree' }
    try {
      expect(approveByRule(inTree({ command: patch('src/a.ts', 'src/b.ts') }), [], edits)).toBe(true)
      expect(approveByRule(inTree({ command: patch('src/a.ts', '/etc/hosts') }), [], edits)).toBe(false)
      expect(approveByRule(inTree({ command: 'not a patch' }), [], edits)).toBe(false)
      expect(approveByRule(ask('exec_command', { cmd: 'npm test' }), [], edits)).toBe(false)
      expect(approveByRule(ask('exec_command', { cmd: 'npm test' }), [], { mode: 'full', root: '/work/tree' })).toBe(true)
      expect(approveByRule(inTree({ command: patch('src/a.ts') }), [], null)).toBe(false)
    } finally {
      process.stdout.write = write
    }
  })
})

describe("codex's pid", () => {
  test('is the parent on macOS and Linux, where the shell execs the hook', () => {
    expect(codexPid(SESSION, { platform: 'darwin', ppid: 4242 })).toBe(4242)
    expect(codexPid(SESSION, { platform: 'linux', ppid: 4242 })).toBe(4242)
  })

  test("is the shell's parent on Windows, asked once per session while that codex runs", () => {
    const run = join(dir, 'windows-run')
    const asked: number[] = []
    const parentOf = (pid: number) => {
      asked.push(pid)
      return process.pid
    }
    expect(codexPid(SESSION, { platform: 'win32', ppid: 111, parentOf, run })).toBe(process.pid)
    expect(codexPid(SESSION, { platform: 'win32', ppid: 222, parentOf, run })).toBe(process.pid)
    expect(asked).toEqual([111])
    // That codex ended: the next one with the session (codex resume) is asked for again.
    writeFileSync(join(run, `codex-${SESSION}.pid`), '999999999')
    expect(codexPid(SESSION, { platform: 'win32', ppid: 333, parentOf, run })).toBe(process.pid)
    expect(asked).toEqual([111, 333])
    // Windows could not tell: the shell's pid, which no channel follows, rather than a guess.
    expect(codexPid('other', { platform: 'win32', ppid: 444, parentOf: () => null, run })).toBe(444)
  })
})

describe('the hook', () => {
  const posts: HookPost[] = []
  const relay = Bun.serve({
    port: 0,
    fetch: async req => {
      if (new URL(req.url).pathname === '/api/hook') posts.push(await req.json())
      return new Response('{}')
    },
  })
  afterAll(() => relay.stop(true))
  const key = newAccountKey()
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ server: `http://127.0.0.1:${relay.port}`, machineId: 'm1', token: 't1', key, machine: 'Mac' }),
  )

  /** As Codex runs it on macOS: `$SHELL -c "exec <agent> hook codex"`, the hook a child of this process. */
  async function run(event: CodexHookInput | string) {
    const child = Bun.spawn(['/bin/sh', '-c', `exec '${process.execPath}' '${AGENT}' hook codex`], {
      env: { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off', TMUX: '', TMUX_PANE: '' },
      stdin: new Blob([typeof event === 'string' ? event : JSON.stringify(event)]),
      stdout: 'pipe',
    })
    const printed = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return printed
  }

  test("links the session to this codex process's channel, and tells the relay its status", async () => {
    const file = join(home, 'run', `${process.pid}.json`)
    expect(await run(input('SessionStart', { source: 'startup' }))).toBe('')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ sessionId: SESSION, transcriptPath: ROLLOUT, tool: 'codex' })
    await run(input('UserPromptSubmit', { prompt: 'SECRET prompt' }))
    await run(input('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' } }))
    await run(
      input('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git push' }, tool_response: 'ok' } as Partial<CodexHookInput>),
    )
    await run(input('PostToolUse', { tool_name: 'Bash' }))
    await run(input('Stop', { stop_hook_active: false }))
    expect(posts.map(post => [post.event.hook_event_name, post.event.notification_type])).toEqual([
      ['SessionStart', undefined],
      ['UserPromptSubmit', undefined],
      ['Notification', 'permission_prompt'],
      ['UserPromptSubmit', undefined],
      ['Stop', undefined],
    ])
    // Only the event travels in clear: the prompt never, the request's text sealed.
    expect(JSON.stringify(posts)).not.toContain('SECRET')
    expect(JSON.stringify(posts)).not.toContain('Bash')
    const detail = posts[2].detail
    expect(detail && (await open(key, detail))).toEqual({ text: 'Codex needs your permission to use Bash' })
    expect(JSON.parse(readFileSync(file, 'utf8')).event).toBe('Stop')
  }, 20_000)

  test('the pool posts its channel could not hand Codex come with the next prompt, once', async () => {
    holdPoolPost(SESSION, '<pool kind="task" from="Ana" task="t1">Build the cart.</pool>', join(home, 'run'))
    holdPoolPost(SESSION, '<pool kind="message" from="Ana">Use the API in the notes.</pool>', join(home, 'run'))
    const printed = JSON.parse(await run(input('UserPromptSubmit', { prompt: 'go on' })))
    expect(printed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    const context = printed.hookSpecificOutput.additionalContext as string
    expect(context).toContain('Pool posts since your last prompt (2)')
    expect(context.indexOf('Build the cart.')).toBeLessThan(context.indexOf('Use the API'))
    expect(await run(input('UserPromptSubmit', { prompt: 'and again' }))).toBe('')
  }, 20_000)

  test('unreadable or foreign input changes nothing and still exits 0', async () => {
    const before = posts.length
    expect(await run('not json')).toBe('')
    expect(await run(JSON.stringify({ hook_event_name: 'Stop' }))).toBe('')
    expect(posts.length).toBe(before)
    expect(existsSync(join(home, 'tonton.log'))).toBe(true)
  }, 20_000)
})
