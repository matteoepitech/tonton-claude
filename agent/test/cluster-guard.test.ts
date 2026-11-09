// The guard of held files (#310): which claims hold which paths, Windows and POSIX alike, what Claude Code's PreToolUse
// hook answers, what OpenCode's plugin is told, and what Codex's PreToolUse hook answers for a patch or a shell command,
// from the file the agent leaves for each cluster session.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearGuardState,
  editedPaths,
  type GuardState,
  guard,
  guardCodexEdit,
  holds,
  OpenCodeGuard,
  readGuardState,
  shellEdits,
  writeGuardState,
} from '../src/cluster/guard'
import { codexEdits } from '../src/codex/hook'
import { withTontonHooks } from '../src/install/claude-settings'
import { guardCall } from '../src/opencode/bridge'

const dir = mkdtempSync(join(tmpdir(), 'tonton-guard-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// In the machine's time, as the reason says it.
const AT = new Date(2026, 10, 4, 14, 2)
const NOW = new Date(2026, 10, 4, 15, 30)

const state = (fields: Partial<GuardState> = {}): GuardState => ({
  sessionId: 'mine',
  root: '/Users/ana/jam/Hero',
  clusters: [
    {
      id: 'c1',
      name: 'Jam',
      claims: [
        { paths: ['Content/Maps/Main.umap'], holder: "Bob's Claude", session: 'bob-1', reason: 'lighting pass', at: AT.toISOString() },
        { paths: ['Content/Characters/Hero/**'], holder: "Chloé's OpenCode", session: 'chloe-1', at: AT.toISOString() },
        { paths: ['Content/Mine.uasset'], holder: 'My Claude', session: 'mine', at: AT.toISOString() },
        { paths: ['Content/Old.uasset'], holder: "Bob's Claude", session: 'bob-1', at: AT.toISOString(), until: AT.toISOString() },
      ],
    },
  ],
  ...fields,
})

describe('holds', () => {
  test('a file, a folder and globs', () => {
    expect(holds('Content/Maps/Main.umap', 'Content/Maps/Main.umap')).toBe(true)
    expect(holds('Content/Maps', 'Content/Maps/Main.umap')).toBe(true)
    expect(holds('Content/Maps/', 'Content/Maps/Sub/Night.umap')).toBe(true)
    expect(holds('Content/Map', 'Content/Maps/Main.umap')).toBe(false)
    expect(holds('Content/Characters/Hero/**', 'Content/Characters/Hero/Rig/SK_Hero.uasset')).toBe(true)
    expect(holds('Content/Characters/Hero/**', 'Content/Characters/Heroine/SK.uasset')).toBe(false)
    expect(holds('Content/*.umap', 'Content/Main.umap')).toBe(true)
    expect(holds('Content/*.umap', 'Content/Maps/Main.uasset')).toBe(false)
    expect(holds('**/*.umap', 'Content/Maps/Main.umap')).toBe(true)
    expect(holds('Content/Props/SM_Rock?.uasset', 'Content/Props/SM_Rock7.uasset')).toBe(true)
    // Perforce's own wildcard.
    expect(holds('Content/Maps/...', 'Content/Maps/Main.umap')).toBe(true)
  })

  test('Windows and POSIX paths, without case', () => {
    expect(holds('Content\\Maps\\Main.umap', 'Content/Maps/Main.umap')).toBe(true)
    expect(holds('Content/Maps/Main.umap', 'Content\\Maps\\Main.umap')).toBe(true)
    expect(holds('content/maps/main.umap', 'Content/Maps/Main.umap')).toBe(true)
    expect(holds('./Content/Maps/Main.umap', 'Content/Maps/Main.umap')).toBe(true)
  })

  test('a depot path, or a file outside the project, holds what ends the same', () => {
    expect(holds('//depot/Hero/Content/Maps/Main.umap', 'Content/Maps/Main.umap')).toBe(true)
    expect(holds('//depot/Hero/Content/Maps/Main.umap#3', 'Content/Maps/Main.umap')).toBe(true)
    expect(holds('Content/Maps/Main.umap', 'D:/Other/Hero/Content/Maps/Main.umap')).toBe(true)
    // One name alone is not enough.
    expect(holds('//depot/Hero/Main.umap', 'Content/Maps/Main.umap')).toBe(false)
  })
})

describe('editedPaths', () => {
  test("Claude Code's and OpenCode's edit tools, and patches", () => {
    expect(editedPaths('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' })).toEqual(['/p/a.ts'])
    expect(editedPaths('MultiEdit', { file_path: '/p/a.ts', edits: [] })).toEqual(['/p/a.ts'])
    expect(editedPaths('NotebookEdit', { notebook_path: '/p/a.ipynb' })).toEqual(['/p/a.ipynb'])
    expect(editedPaths('write', { filePath: 'src/a.ts', content: 'x' })).toEqual(['src/a.ts'])
    const patchText = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+x\n*** End Patch'
    expect(editedPaths('apply_patch', { patchText })).toEqual(['src/a.ts', 'src/b.ts'])
    expect(editedPaths('Read', { file_path: '/p/a.ts' })).toEqual([])
    expect(editedPaths('Edit', null)).toEqual([])
  })
})

describe('guard', () => {
  const edit = (file_path: string) => ({ file_path, old_string: 'a', new_string: 'b' })

  test('a file another session holds asks, with who holds it, since when and why', () => {
    expect(guard(state(), 'Edit', edit('/Users/ana/jam/Hero/Content/Maps/Main.umap'), '/Users/ana/jam/Hero', NOW)).toEqual({
      decision: 'ask',
      reason: "Content/Maps/Main.umap is held by Bob's Claude since 14:02 (lighting pass)",
      path: 'Content/Maps/Main.umap',
    })
    expect(guard(state(), 'Write', { file_path: '/Users/ana/jam/Hero/Content/Characters/Hero/Rig.uasset' }, undefined, NOW)).toMatchObject({
      decision: 'ask',
      reason: "Content/Characters/Hero/Rig.uasset is held by Chloé's OpenCode since 14:02",
    })
  })

  test('on Windows, from the working folder too', () => {
    const windows = state({ root: 'C:\\Jam\\Hero' })
    expect(guard(windows, 'Edit', edit('C:\\Jam\\Hero\\Content\\Maps\\Main.umap'), 'C:\\Jam\\Hero', NOW)?.path).toBe(
      'Content/Maps/Main.umap',
    )
    expect(guard(windows, 'edit', { filePath: 'Content\\Maps\\Main.umap' }, 'C:\\Jam\\Hero', NOW)?.path).toBe('Content/Maps/Main.umap')
    expect(guard(state({ root: undefined }), 'edit', { filePath: 'Maps/Main.umap' }, '/Users/ana/jam/Hero/Content', NOW)).toBeNull()
    expect(guard(state({ root: undefined }), 'edit', { filePath: 'Content/Maps/Main.umap' }, '/Users/ana/jam/Hero', NOW)?.path).toBe(
      'Content/Maps/Main.umap',
    )
  })

  test("free files, this session's own claims and lapsed ones let the edit through", () => {
    const at = (path: string) => guard(state(), 'Edit', edit(`/Users/ana/jam/Hero/${path}`), undefined, NOW)
    expect(at('Content/Maps/Other.umap')).toBeNull()
    expect(at('Content/Mine.uasset')).toBeNull()
    expect(at('Content/Old.uasset')).toBeNull()
    expect(guard(null, 'Edit', edit('/Users/ana/jam/Hero/Content/Maps/Main.umap'))).toBeNull()
    expect(guard(state(), 'Read', { file_path: '/Users/ana/jam/Hero/Content/Maps/Main.umap' })).toBeNull()
  })

  test('a cluster that blocks refuses the edit', () => {
    const blocking = state()
    blocking.clusters[0].block = true
    expect(guard(blocking, 'Edit', edit('/Users/ana/jam/Hero/Content/Maps/Main.umap'), undefined, NOW)).toEqual({
      decision: 'deny',
      reason: "Content/Maps/Main.umap is held by Bob's Claude since 14:02 (lighting pass). Jam lets no one edit a file someone else holds.",
      path: 'Content/Maps/Main.umap',
    })
  })

  test('a patch that changes several held files names the first and counts the others', () => {
    const patchText = '*** Update File: Content/Maps/Main.umap\n*** Update File: Content/Characters/Hero/Rig.uasset\n'
    expect(guard(state(), 'apply_patch', { patchText }, '/Users/ana/jam/Hero', NOW)?.reason).toBe(
      "Content/Maps/Main.umap is held by Bob's Claude since 14:02 (lighting pass), and 1 more file is held",
    )
  })

  test('the day is said when it was not today', () => {
    const tomorrow = new Date(2026, 10, 5, 9, 0)
    expect(guard(state(), 'Edit', edit('/Users/ana/jam/Hero/Content/Maps/Main.umap'), undefined, tomorrow)?.reason).toContain(
      'since 2026-11-04 14:02',
    )
  })
})

describe('the guard file', () => {
  test('written whole, read back, and cleared', () => {
    const folder = join(dir, 'files')
    writeGuardState(state(), folder)
    expect(readGuardState('mine', folder)).toEqual({
      ...state(),
      clusters: state().clusters.map(cluster => ({ ...cluster, block: false })),
    })
    clearGuardState('mine', folder)
    expect(readGuardState('mine', folder)).toBeNull()
  })

  test("anything else is no guard: another session's file, bad JSON, bad claims", () => {
    const folder = join(dir, 'bad')
    writeGuardState(state(), folder)
    writeFileSync(join(folder, 'other.json'), JSON.stringify(state()))
    expect(readGuardState('other', folder)).toBeNull()
    writeFileSync(join(folder, 'broken.json'), '{')
    expect(readGuardState('broken', folder)).toBeNull()
    const odd = {
      sessionId: 'odd',
      clusters: [{ id: 'c', claims: [{ paths: 'x' }, null, { paths: ['a'], holder: 'B', session: 's', at: 'x' }] }, 5],
    }
    writeFileSync(join(folder, 'odd.json'), JSON.stringify(odd))
    expect(readGuardState('odd', folder)?.clusters[0].claims).toEqual([{ paths: ['a'], holder: 'B', session: 's', at: 'x' }])
    expect(readGuardState('../mine', folder)).toBeNull()
  })
})

describe('OpenCode', () => {
  test('a held file stops the edit once with the reason; the same edit again goes through', () => {
    const folder = join(dir, 'opencode')
    writeGuardState({ ...state(), sessionId: 'ses_1' }, folder)
    const opencode = new OpenCodeGuard(folder)
    const input = { filePath: 'Content/Maps/Main.umap' }
    expect(opencode.answer('ses_1', 'edit', input, '/Users/ana/jam/Hero', NOW)).toBe(
      "Content/Maps/Main.umap is held by Bob's Claude since 14:02 (lighting pass). Ask your user before you edit it. If they agree, make the same edit again.",
    )
    expect(opencode.answer('ses_1', 'edit', input, '/Users/ana/jam/Hero', NOW)).toBe('')
    expect(opencode.answer('ses_1', 'edit', input, '/Users/ana/jam/Hero', NOW)).toContain('Ask your user')
    // Long after, it asks again.
    const later = new Date(NOW.getTime() + 11 * 60 * 1000)
    expect(opencode.answer('ses_1', 'edit', input, '/Users/ana/jam/Hero', later)).toContain('Ask your user')
    expect(opencode.answer('ses_1', 'edit', { filePath: 'Content/Free.umap' }, '/Users/ana/jam/Hero', NOW)).toBe('')
    expect(opencode.answer('ses_2', 'edit', input, '/Users/ana/jam/Hero', NOW)).toBe('')
  })

  test('the bridge reads what the plugin asks, and skips anything else', () => {
    const data = { callID: 'guard-1', sessionID: 'ses_1', tool: 'edit', args: { filePath: 'a.ts' } }
    expect(guardCall({ type: 'tonton.guard', data })).toEqual(data)
    expect(guardCall({ type: 'tonton.guard', data: { ...data, args: [1] } })).toEqual({ ...data, args: {} })
    for (const event of [
      null,
      5,
      { type: 'tonton.tool', data },
      { type: 'tonton.guard' },
      { type: 'tonton.guard', data: { ...data, tool: 3 } },
    ]) {
      expect(guardCall(event)).toBeNull()
    }
  })

  test('a cluster that blocks always refuses', () => {
    const folder = join(dir, 'opencode-block')
    const blocking = { ...state(), sessionId: 'ses_1' }
    blocking.clusters[0].block = true
    writeGuardState(blocking, folder)
    const opencode = new OpenCodeGuard(folder)
    for (let i = 0; i < 2; i++) {
      expect(opencode.answer('ses_1', 'write', { filePath: 'Content/Maps/Main.umap' }, '/Users/ana/jam/Hero', NOW)).toContain(
        'Jam lets no one',
      )
    }
  })
})

describe('Claude Code', () => {
  const AGENT = join(import.meta.dir, '../src/main.ts')
  const home = join(dir, 'home')
  const env = { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off' } as Record<string, string>
  const hook = async (input: object) => {
    const child = Bun.spawn(['bun', AGENT, 'hook'], { env, stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe' })
    return new Response(child.stdout).text()
  }
  const call = (event: string, file_path: string) => ({
    hook_event_name: event,
    session_id: 'mine',
    cwd: '/Users/ana/jam/Hero',
    tool_name: 'Edit',
    tool_input: { file_path, old_string: 'a', new_string: 'b' },
  })

  test('the PreToolUse hook asks before an edit of a held file, and says nothing otherwise', async () => {
    writeGuardState(state(), join(home, 'cluster-guard'))
    const answer = JSON.parse(await hook(call('PreToolUse', '/Users/ana/jam/Hero/Content/Maps/Main.umap')))
    expect(answer.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'ask' })
    // The hook reads the machine's time: the claim's day is said once it is not today.
    expect(answer.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^Content\/Maps\/Main\.umap is held by Bob's Claude since (\d{4}-\d\d-\d\d )?\d\d:\d\d/,
    )
    expect(await hook(call('PreToolUse', '/Users/ana/jam/Hero/Content/Free.umap'))).toBe('')
    expect(await hook({ ...call('PreToolUse', '/Users/ana/jam/Hero/Content/Maps/Main.umap'), session_id: 'other' })).toBe('')
  })

  test('no auto-approve rule lets a held file through, and the guard ends with the session', async () => {
    writeFileSync(join(home, 'rules.json'), JSON.stringify({ rules: [{ tool: 'Edit' }], issuedAt: '2026-11-04T10:00:00Z' }))
    const allowed = JSON.parse(await hook(call('PermissionRequest', '/Users/ana/jam/Hero/Content/Free.umap')))
    expect(allowed.hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
    expect(await hook(call('PermissionRequest', '/Users/ana/jam/Hero/Content/Maps/Main.umap'))).toBe('')
    await hook({ hook_event_name: 'SessionEnd', session_id: 'mine' })
    expect(readGuardState('mine', join(home, 'cluster-guard'))).toBeNull()
  })

  test('the hook runs before the edit tools only', () => {
    const settings = withTontonHooks({}, '/home/me/.tonton/bin/tonton')
    expect(settings.hooks?.PreToolUse).toEqual([
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: '/home/me/.tonton/bin/tonton', args: ['hook'], timeout: 5 }],
      },
    ])
    expect(settings.hooks?.Stop?.[0]).not.toHaveProperty('matcher')
  })
})

describe('the files a shell command writes', () => {
  test('what its output goes to, and what common programs change', () => {
    expect(shellEdits('echo hi > Content/Notes.md && cat a.txt >> log/build.log 2>/dev/null')).toEqual([
      'Content/Notes.md',
      'log/build.log',
    ])
    expect(shellEdits('make 2>&1 | tee -a build.log')).toEqual(['build.log'])
    expect(shellEdits("sed -i '' 's/Hero/Heroine/' Config/Game.ini")).toEqual(['Config/Game.ini'])
    expect(shellEdits("sed -i.bak -e 's/a/b/' -e 's/c/d/' one.txt two.txt")).toEqual(['one.txt', 'two.txt'])
    expect(shellEdits("perl -pi -e 's/a/b/' src/a.ts")).toEqual(['src/a.ts'])
    expect(shellEdits('rm -rf build && mv a.txt b.txt && cp -r Assets/Hero Content/Hero && touch x && truncate -s 0 y')).toEqual([
      'build',
      'a.txt',
      'b.txt',
      'Content/Hero',
      'x',
      'y',
    ])
    expect(shellEdits('dd if=/dev/zero of=disk.img bs=1m count=1')).toEqual(['disk.img'])
    expect(shellEdits("bash -lc 'cd Source && echo x > Hero.cpp'")).toEqual(['Source/Hero.cpp'])
    expect(shellEdits('cd /tmp/other && rm a; rm b')).toEqual(['/tmp/other/a', '/tmp/other/b'])
    expect(shellEdits("Set-Content -Path Config\\Game.ini -Value 'x'; Remove-Item old.txt")).toEqual(['Config\\Game.ini', 'old.txt'])
    expect(shellEdits('del /q Content\\Old.uasset')).toEqual(['Content\\Old.uasset'])
  })

  test('a patch it applies, here-document and all', () => {
    const command = "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: Content/Maps/Main.umap\n@@\n-a\n+b\n*** End Patch\nEOF"
    expect(shellEdits(command)).toEqual(['Content/Maps/Main.umap'])
  })

  test('what only reads, or writes nowhere, is no edit', () => {
    for (const command of [
      'git status',
      'cat Content/Maps/Main.umap | grep x',
      'sed -n 1,20p Config/Game.ini',
      'perl -ne print a.txt',
      'make > /dev/null 2>&1',
      'echo $HOME > $OUT',
      'ls >&2',
      '',
    ])
      expect([command, shellEdits(command)]).toEqual([command, []])
  })
})

describe('Codex', () => {
  const AGENT = join(import.meta.dir, '../src/main.ts')
  const home = join(dir, 'codex-home')
  const env = { ...process.env, TONTON_HOME: home, TONTON_SERVICE: 'off' } as Record<string, string>
  const hook = async (input: object) => {
    const child = Bun.spawn(['/bin/sh', '-c', `exec '${process.execPath}' '${AGENT}' hook codex`], {
      env,
      stdin: new Blob([JSON.stringify(input)]),
      stdout: 'pipe',
    })
    return new Response(child.stdout).text()
  }
  const call = (tool_name: string, tool_input: object) => ({
    hook_event_name: 'PreToolUse',
    session_id: 'mine',
    turn_id: 't1',
    cwd: '/Users/ana/jam/Hero',
    permission_mode: 'default',
    tool_name,
    tool_input,
  })
  const patch = (path: string) => `*** Begin Patch\n*** Update File: ${path}\n@@\n-a\n+b\n*** End Patch`

  test("the files of Codex's calls: a patch's, and what a shell command writes", () => {
    expect(codexEdits('apply_patch', { command: patch('Content/Maps/Main.umap') })).toEqual(['Content/Maps/Main.umap'])
    expect(codexEdits('Bash', { command: "sed -i 's/a/b/' Content/Maps/Main.umap" })).toEqual(['Content/Maps/Main.umap'])
    expect(codexEdits('shell', { command: ['bash', '-lc', 'echo x > a.txt'] })).toEqual(['a.txt'])
    expect(codexEdits('Bash', { command: 'git status' })).toEqual([])
    expect(codexEdits('mcp__tonton__cluster_who', {})).toEqual([])
    expect(codexEdits('apply_patch', 'nonsense')).toEqual([])
  })

  test('a held file stops the edit once, as Codex takes no ask; the same edit again goes through', () => {
    const folder = join(dir, 'codex-guard')
    writeGuardState(state(), folder)
    const edited = ['Content/Maps/Main.umap']
    expect(guardCodexEdit('mine', edited, '/Users/ana/jam/Hero', NOW, folder)).toBe(
      "Content/Maps/Main.umap is held by Bob's Claude since 14:02 (lighting pass). Ask your user before you edit it. If they agree, make the same edit again.",
    )
    expect(guardCodexEdit('mine', edited, '/Users/ana/jam/Hero', NOW, folder)).toBe('')
    expect(guardCodexEdit('mine', edited, '/Users/ana/jam/Hero', NOW, folder)).toContain('Ask your user')
    expect(guardCodexEdit('mine', ['Content/Free.umap', 'Content/Mine.uasset'], '/Users/ana/jam/Hero', NOW, folder)).toBe('')
    // Gone with the session's guard, when it leaves its last cluster or ends.
    clearGuardState('mine', folder)
    expect(guardCodexEdit('mine', edited, '/Users/ana/jam/Hero', NOW, folder)).toBe('')
  })

  test("the PreToolUse hook denies a held file's patch or shell edit with the reason, and says nothing otherwise", async () => {
    writeGuardState(state(), join(home, 'cluster-guard'))
    const denied = JSON.parse(await hook(call('apply_patch', { command: patch('Content/Characters/Hero/Rig.uasset') })))
    expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(denied.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^Content\/Characters\/Hero\/Rig\.uasset is held by Chloé's OpenCode/,
    )
    // Only the fields Codex reads: it refuses an output with any other (deny_unknown_fields in codex-rs/hooks/src/schema.rs).
    expect(Object.keys(denied.hookSpecificOutput).sort()).toEqual(['hookEventName', 'permissionDecision', 'permissionDecisionReason'])
    const shell = JSON.parse(await hook(call('Bash', { command: 'echo lit > Content/Maps/Main.umap' })))
    expect(shell.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(await hook(call('Bash', { command: 'echo lit > Content/Maps/Main.umap' }))).toBe('')
    expect(await hook(call('Bash', { command: 'cat Content/Maps/Main.umap' }))).toBe('')
    expect(await hook(call('apply_patch', { command: patch('Content/Free.umap') }))).toBe('')
  })
})
