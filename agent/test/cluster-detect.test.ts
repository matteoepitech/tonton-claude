// The cluster's automatic events (#311) and claims (#310), read from shell calls the way Claude Code's transcripts and
// OpenCode 1 and 2 give them: each command when it works and when it fails, with POSIX and Windows paths.
import { describe, expect, test } from 'bun:test'
import { commandsOf, type Detected, detect, EventDetector, normalizePath, projectPath } from '../src/cluster/detect'
import { OpenCodeTracker } from '../src/opencode/events'
import { parseLine } from '../src/transcript/parser'

interface Call {
  command: string
  output: string
  /** The exit code: Claude Code makes a result an error from it, OpenCode passes it in the tool's metadata. */
  exit?: number
}

const POSIX_ROOT = '/Users/ana/jam/Hero'
const WINDOWS_ROOT = 'C:\\Jam\\Hero'

/** A Claude Code transcript: the assistant's Bash call, then the user line with its result. */
function claudeCode(calls: Call[], root?: string): Detected[] {
  const detector = new EventDetector(root)
  return calls.flatMap(({ command, output, exit = 0 }, index) => {
    const call = {
      type: 'assistant',
      uuid: `a${index}`,
      timestamp: '2026-11-04T14:02:00Z',
      message: { content: [{ type: 'tool_use', id: `toolu_${index}`, name: 'Bash', input: { command, description: 'Run it' } }] },
    }
    const content = exit ? `Exit code ${exit}\n${output}` : output
    const result = {
      type: 'user',
      uuid: `u${index}`,
      timestamp: '2026-11-04T14:02:05Z',
      message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${index}`, content, is_error: exit !== 0 }] },
    }
    return detector.read([...parseLine(JSON.stringify(call)).entries, ...parseLine(JSON.stringify(result)).entries])
  })
}

/** OpenCode 2's events for a shell call: its name, its input, then its output with the exit code. */
function openCode2(calls: Call[], root?: string): Detected[] {
  const tracker = new OpenCodeTracker()
  const detector = new EventDetector(root)
  return calls.flatMap(({ command, output, exit = 0 }, index) => {
    const data = { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: `call_${index}` }
    const events = [
      { id: `e${index}a`, created: 1_793_028_419_000, type: 'session.tool.input.started', data: { ...data, name: 'shell' } },
      {
        id: `e${index}b`,
        created: 1_793_028_419_100,
        type: 'session.tool.called',
        data: { ...data, input: { command, description: 'Run it' } },
      },
      {
        id: `e${index}c`,
        created: 1_793_028_420_000,
        type: 'session.tool.success',
        data: { ...data, content: [{ type: 'text', text: output }], metadata: { status: 'completed', truncated: false, exit } },
      },
    ]
    return detector.read(events.flatMap(event => tracker.handle(event)).flatMap(update => update.entries))
  })
}

/** OpenCode 1's parts: the bash tool running, then completed with its output and exit code. */
function openCode1(calls: Call[], root?: string): Detected[] {
  const tracker = new OpenCodeTracker()
  const detector = new EventDetector(root)
  tracker.handle({
    type: 'message.updated',
    properties: { info: { id: 'm1', sessionID: 'ses_1', role: 'assistant', time: { created: 1 } } },
  })
  return calls.flatMap(({ command, output, exit = 0 }, index) => {
    const part = (state: object) => ({
      type: 'message.part.updated',
      properties: {
        part: { id: `p${index}`, sessionID: 'ses_1', messageID: 'm1', type: 'tool', callID: `c${index}`, tool: 'bash', state },
      },
    })
    const events = [
      part({ status: 'running', input: { command } }),
      part({ status: 'completed', input: { command }, output, metadata: { output, exit, description: 'Run it' } }),
    ]
    return detector.read(events.flatMap(event => tracker.handle(event)).flatMap(update => update.entries))
  })
}

const SOURCES = { 'Claude Code': claudeCode, 'OpenCode 2': openCode2, 'OpenCode 1': openCode1 }
const posted = (detected: Detected[]) => detected.map(({ kind, text, event }) => ({ kind, text, event }))

interface Case {
  name: string
  calls: Call[]
  root?: string
  expected: Omit<Detected, 'ts'>[]
}

const CASES: Case[] = [
  // Git
  {
    name: 'git commit',
    calls: [
      {
        command: 'git add -A && git commit -m "Add the hero rig"',
        output:
          '[main 4f2a9c1] Add the hero rig\n 3 files changed, 120 insertions(+), 4 deletions(-)\n create mode 100644 Content/Hero.uasset\n',
      },
    ],
    expected: [
      {
        kind: 'event',
        text: 'Committed 4f2a9c1 on main: Add the hero rig (3 files)',
        event: { type: 'commit', ok: true, ref: '4f2a9c1', count: 3 },
      },
    ],
  },
  {
    name: 'git commit with nothing to commit',
    calls: [{ command: 'git commit -m "x"', output: 'On branch main\nnothing to commit, working tree clean\n', exit: 1 }],
    expected: [],
  },
  {
    name: 'git commit then git push, the push cut from a long summary',
    calls: [
      {
        command: `git add -A && git commit -m "$(cat <<'EOF'\nAdd the hero rig\n\n${'Sockets for the sword and the shield. '.repeat(8)}\nEOF\n)" && git push`,
        output:
          '[feat/hero 4f2a9c1] Add the hero rig\n 1 file changed, 2 insertions(+)\nTo github.com:jam/hero.git\n * [new branch]      feat/hero -> feat/hero\n',
      },
    ],
    expected: [
      {
        kind: 'event',
        text: 'Committed 4f2a9c1 on feat/hero: Add the hero rig (1 file)',
        event: { type: 'commit', ok: true, ref: '4f2a9c1', count: 1 },
      },
      {
        kind: 'event',
        text: 'Pushed 1 commit to feat/hero: Add the hero rig',
        event: { type: 'push', ok: true, ref: 'feat/hero', count: 1 },
      },
    ],
  },
  {
    name: 'git push of the commits made before it',
    calls: [
      { command: 'git commit -am "Rig the hero"', output: '[main 1111111] Rig the hero\n 1 file changed, 1 insertion(+)\n' },
      { command: 'git commit -am "Skin the hero"', output: '[main 2222222] Skin the hero\n 2 files changed, 1 insertion(+)\n' },
      { command: 'git push origin main', output: 'To https://github.com/jam/hero.git\n   0a0a0a0..2222222  main -> main\n' },
      { command: 'git push', output: 'Everything up-to-date\n' },
    ],
    expected: [
      {
        kind: 'event',
        text: 'Committed 1111111 on main: Rig the hero (1 file)',
        event: { type: 'commit', ok: true, ref: '1111111', count: 1 },
      },
      {
        kind: 'event',
        text: 'Committed 2222222 on main: Skin the hero (2 files)',
        event: { type: 'commit', ok: true, ref: '2222222', count: 2 },
      },
      { kind: 'event', text: 'Pushed 2 commits to main: Skin the hero', event: { type: 'push', ok: true, ref: 'main', count: 2 } },
    ],
  },
  {
    name: 'git push rejected',
    calls: [
      {
        command: 'git push',
        output:
          "To github.com:jam/hero.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:jam/hero.git'\n",
        exit: 1,
      },
    ],
    expected: [{ kind: 'event', text: 'Push to main was rejected (fetch first)', event: { type: 'push', ok: false, ref: 'main' } }],
  },
  {
    name: 'git lfs lock and unlock, with a Windows path',
    calls: [
      { command: 'git lfs lock Content\\Maps\\Main.umap', output: 'Locked Content\\Maps\\Main.umap\n' },
      { command: 'git lfs lock Content/Maps/Main.umap', output: 'Lock exists\n', exit: 2 },
      { command: 'git lfs unlock Content/Maps/Main.umap', output: 'Unlocked Content/Maps/Main.umap\n' },
    ],
    expected: [
      { kind: 'claim', text: 'Locked in Git LFS: Content/Maps/Main.umap', event: { type: 'claim', paths: ['Content/Maps/Main.umap'] } },
      { kind: 'claim', text: 'Unlocked in Git LFS: Content/Maps/Main.umap', event: { type: 'release', paths: ['Content/Maps/Main.umap'] } },
    ],
  },

  // Perforce
  {
    name: 'p4 edit, add and delete',
    root: POSIX_ROOT,
    calls: [
      { command: 'p4 edit Content/Maps/Main.umap', output: '//depot/Hero/Content/Maps/Main.umap#3 - opened for edit\n' },
      { command: 'p4 add Content/Trees/SM_Tree.uasset', output: '//depot/Hero/Content/Trees/SM_Tree.uasset#1 - opened for add\n' },
      { command: 'p4 delete Content/Old.uasset', output: '//depot/Hero/Content/Old.uasset#2 - opened for delete\n' },
      { command: 'p4 edit Content/Nope.uasset', output: 'Content/Nope.uasset - file(s) not on client.\n', exit: 1 },
      {
        command: 'p4 edit Content/Maps/Main.umap',
        output: "//depot/Hero/Content/Maps/Main.umap - can't edit exclusive file already opened\n",
        exit: 1,
      },
    ],
    expected: [
      {
        kind: 'claim',
        text: 'Opened for edit in Perforce: Content/Maps/Main.umap',
        event: { type: 'claim', paths: ['Content/Maps/Main.umap'] },
      },
      {
        kind: 'claim',
        text: 'Opened for add in Perforce: Content/Trees/SM_Tree.uasset',
        event: { type: 'claim', paths: ['Content/Trees/SM_Tree.uasset'] },
      },
      { kind: 'claim', text: 'Opened for delete in Perforce: Content/Old.uasset', event: { type: 'claim', paths: ['Content/Old.uasset'] } },
    ],
  },
  {
    name: 'p4 edit on Windows',
    root: WINDOWS_ROOT,
    calls: [{ command: 'p4 edit Content\\Maps\\Main.umap', output: '//depot/Hero/Content/Maps/Main.umap#3 - opened for edit\r\n' }],
    expected: [
      {
        kind: 'claim',
        text: 'Opened for edit in Perforce: Content/Maps/Main.umap',
        event: { type: 'claim', paths: ['Content/Maps/Main.umap'] },
      },
    ],
  },
  {
    name: 'p4 submit',
    root: POSIX_ROOT,
    calls: [
      {
        command: 'p4 submit -d "Hero model and rig"',
        output: [
          'Change 1234 created with 2 open file(s).',
          'Submitting change 1234.',
          'Locking 2 files ...',
          'edit //depot/Hero/Content/Characters/Hero/SK_Hero.uasset#4',
          'add //depot/Hero/Content/Trees/SM_Tree.uasset#1',
          'Change 1234 submitted.',
        ].join('\n'),
      },
    ],
    expected: [
      {
        kind: 'event',
        text: 'Submitted change 1234 to Perforce: Hero model and rig (2 files)',
        event: { type: 'submit', ok: true, ref: '1234', count: 2 },
      },
      {
        kind: 'claim',
        text: 'Submitted, no longer held: Content/Characters/Hero/SK_Hero.uasset, Content/Trees/SM_Tree.uasset',
        event: { type: 'release', ref: '1234', paths: ['Content/Characters/Hero/SK_Hero.uasset', 'Content/Trees/SM_Tree.uasset'] },
      },
    ],
  },
  {
    name: 'p4 submit renamed by the server',
    calls: [
      {
        command: 'p4 submit -c 1234',
        output: 'Submitting change 1234.\nLocking 1 files ...\nChange 1234 renamed change 1240 and submitted.\n',
      },
    ],
    expected: [
      { kind: 'event', text: 'Submitted change 1240 to Perforce (1 file)', event: { type: 'submit', ok: true, ref: '1240', count: 1 } },
    ],
  },
  {
    name: 'p4 submit with files to resolve',
    calls: [
      {
        command: 'p4 submit -c 1235',
        output: [
          'Submitting change 1235.',
          'Locking 1 files ...',
          '//depot/Hero/Content/Maps/Main.umap#3 - must resolve #4 before submitting',
          'Out of date files must be resolved or reverted.',
          "Submit aborted -- fix problems then use 'p4 submit -c 1235'.",
        ].join('\n'),
        exit: 1,
      },
    ],
    expected: [
      {
        kind: 'event',
        text: 'Perforce submit of change 1235 failed: files to resolve first',
        event: { type: 'submit', ok: false, ref: '1235' },
      },
    ],
  },
  {
    name: 'p4 shelve',
    calls: [
      {
        command: 'p4 shelve -c 1236',
        output: 'Shelving files for change 1236.\nedit //depot/Hero/Content/Maps/Main.umap#3\nChange 1236 files shelved.\n',
      },
      { command: 'p4 shelve', output: 'No files to shelve.\n', exit: 1 },
    ],
    expected: [
      { kind: 'event', text: 'Shelved change 1236 in Perforce (1 file)', event: { type: 'shelve', ok: true, ref: '1236', count: 1 } },
      { kind: 'event', text: 'Perforce shelve failed', event: { type: 'shelve', ok: false } },
    ],
  },
  {
    name: 'p4 revert',
    root: WINDOWS_ROOT,
    calls: [
      {
        command: 'p4 revert Content/...',
        output: '//depot/Hero/Content/Maps/Main.umap#3 - was edit, reverted\n//depot/Hero/Content/New.uasset#none - was add, abandoned\n',
      },
    ],
    expected: [
      {
        kind: 'claim',
        text: 'Reverted in Perforce: Content/Maps/Main.umap, Content/New.uasset',
        event: { type: 'release', paths: ['Content/Maps/Main.umap', 'Content/New.uasset'] },
      },
    ],
  },

  // Builds
  {
    name: 'UnrealBuildTool through Build.bat',
    calls: [
      {
        command:
          '"C:\\Program Files\\Epic Games\\UE_5.4\\Engine\\Build\\BatchFiles\\Build.bat" HeroEditor Win64 Development -Project="C:\\Jam\\Hero\\Hero.uproject" -WaitMutex',
        output:
          'Using bundled DotNet SDK version: 6.0.302\nBuilding HeroEditor...\n[1/4] Compile Module.Hero.cpp\nResult: Succeeded\nTotal execution time: 41.20 seconds\n',
      },
      {
        command:
          '"/Users/Shared/Epic Games/UE_5.4/Engine/Build/BatchFiles/Mac/Build.sh" HeroEditor Mac Development -Project=/Users/ana/jam/Hero/Hero.uproject',
        output: "Hero.cpp(12): error C2065: 'Foo': undeclared identifier\nResult: Failed (OtherCompilationError)\n",
        exit: 6,
      },
    ],
    expected: [
      {
        kind: 'event',
        text: 'Build succeeded: UnrealBuildTool HeroEditor Win64 Development',
        event: { type: 'build', ok: true, ref: 'UnrealBuildTool HeroEditor Win64 Development' },
      },
      {
        kind: 'event',
        text: 'Build failed: UnrealBuildTool HeroEditor Mac Development',
        event: { type: 'build', ok: false, ref: 'UnrealBuildTool HeroEditor Mac Development' },
      },
    ],
  },
  {
    name: 'RunUAT BuildCookRun',
    calls: [
      {
        command:
          'cmd /c "C:\\UE_5.4\\Engine\\Build\\BatchFiles\\RunUAT.bat BuildCookRun -project=C:\\Jam\\Hero\\Hero.uproject -platform=Win64 -clientconfig=Shipping -build -cook -stage -pak"',
        output: 'BUILD SUCCESSFUL\nAutomationTool exiting with ExitCode=0 (Success)\n',
      },
      {
        command: './RunUAT.sh BuildCookRun -project=/Users/ana/jam/Hero/Hero.uproject -platform=Mac -clientconfig=Development -cook',
        output: 'BUILD FAILED\nAutomationTool exiting with ExitCode=25 (Error_UnknownCookFailure)\n',
        exit: 25,
      },
    ],
    expected: [
      {
        kind: 'event',
        text: 'Build succeeded: BuildCookRun Win64 Shipping',
        event: { type: 'build', ok: true, ref: 'BuildCookRun Win64 Shipping' },
      },
      {
        kind: 'event',
        text: 'Build failed: BuildCookRun Mac Development',
        event: { type: 'build', ok: false, ref: 'BuildCookRun Mac Development' },
      },
    ],
  },
  {
    name: 'dotnet, npm, bun, cargo and make',
    calls: [
      { command: 'dotnet build Hero.sln', output: 'Build succeeded.\n    0 Warning(s)\n    0 Error(s)\n' },
      { command: 'dotnet build Hero.sln', output: 'Program.cs(3,1): error CS0103\nBuild FAILED.\n    1 Error(s)\n', exit: 1 },
      { command: 'cd web && npm run build', output: '> web@1.0.0 build\n> vite build\n✓ built in 1.20s\n' },
      { command: 'npm run build 2>&1 | tail -5', output: 'npm error Lifecycle script `build` failed with error:\nnpm error code 2\n' },
      { command: 'bun run build:web', output: 'error: script "build:web" exited with code 1\n', exit: 1 },
      {
        command: 'cargo build --release',
        output: 'error[E0425]: cannot find value `x`\nerror: could not compile `hero` due to 1 previous error\n',
        exit: 101,
      },
      { command: 'make -j 8 hero', output: 'cc -o hero hero.c\n' },
      { command: 'make clean', output: 'rm -f hero\n' },
      { command: 'make', output: "hero.c:3: error: expected ';'\nmake: *** [Makefile:12: hero] Error 1\n", exit: 2 },
      // Only the exit code says this one failed.
      { command: 'go build ./...', output: './main.go:3:2: undefined: hero\n', exit: 1 },
    ],
    expected: [
      { kind: 'event', text: 'Build succeeded: dotnet build', event: { type: 'build', ok: true, ref: 'dotnet build' } },
      { kind: 'event', text: 'Build failed: dotnet build', event: { type: 'build', ok: false, ref: 'dotnet build' } },
      { kind: 'event', text: 'Build succeeded: npm run build', event: { type: 'build', ok: true, ref: 'npm run build' } },
      { kind: 'event', text: 'Build failed: npm run build', event: { type: 'build', ok: false, ref: 'npm run build' } },
      { kind: 'event', text: 'Build failed: bun run build:web', event: { type: 'build', ok: false, ref: 'bun run build:web' } },
      { kind: 'event', text: 'Build failed: cargo build', event: { type: 'build', ok: false, ref: 'cargo build' } },
      { kind: 'event', text: 'Build succeeded: make hero', event: { type: 'build', ok: true, ref: 'make hero' } },
      { kind: 'event', text: 'Build failed: make', event: { type: 'build', ok: false, ref: 'make' } },
      { kind: 'event', text: 'Build failed: go build', event: { type: 'build', ok: false, ref: 'go build' } },
    ],
  },

  // Tests
  {
    name: 'test runs',
    calls: [
      { command: 'bun test', output: ' 12 pass\n 0 fail\n 30 expect() calls\nRan 12 tests across 2 files. [120.00ms]\n' },
      { command: 'bun test agent', output: '(fail) parser > reads it\n 11 pass\n 1 fail\nRan 12 tests across 2 files.\n', exit: 1 },
      { command: 'cargo test', output: 'running 10 tests\ntest result: ok. 10 passed; 0 failed; 0 ignored; 0 measured\n' },
      { command: 'python -m pytest tests', output: '==================== 1 failed, 5 passed in 0.30s ====================\n', exit: 1 },
      { command: 'npx jest', output: 'Tests:       2 failed, 8 passed, 10 total\n', exit: 1 },
      { command: 'dotnet test', output: 'Passed!  - Failed:     0, Passed:     9, Skipped:     0, Total:     9\n' },
      {
        command: 'UnrealEditor-Cmd.exe Hero.uproject -ExecCmds="Automation RunTests Hero.; Quit" -unattended -nullrhi',
        output: 'LogAutomationController: Test Completed. Result={Success}\n**** TEST COMPLETE. EXIT CODE: 0 ****\n',
      },
    ],
    expected: [
      { kind: 'event', text: 'Tests passed: bun test (12 tests)', event: { type: 'test', ok: true, ref: 'bun test', count: 12 } },
      { kind: 'event', text: 'Tests failed: bun test (1 of 12 failed)', event: { type: 'test', ok: false, ref: 'bun test', count: 12 } },
      { kind: 'event', text: 'Tests passed: cargo test (10 tests)', event: { type: 'test', ok: true, ref: 'cargo test', count: 10 } },
      { kind: 'event', text: 'Tests failed: pytest (1 of 6 failed)', event: { type: 'test', ok: false, ref: 'pytest', count: 6 } },
      { kind: 'event', text: 'Tests failed: jest (2 of 10 failed)', event: { type: 'test', ok: false, ref: 'jest', count: 10 } },
      { kind: 'event', text: 'Tests passed: dotnet test (9 tests)', event: { type: 'test', ok: true, ref: 'dotnet test', count: 9 } },
      { kind: 'event', text: 'Tests passed: Unreal automation tests', event: { type: 'test', ok: true, ref: 'Unreal automation tests' } },
    ],
  },
  {
    name: 'a build and its tests in one call',
    calls: [
      { command: 'npm run build && npm test', output: 'built\nTests:       5 passed, 5 total\n' },
      // The build failed and the tests never ran: neither is told rather than the wrong one.
      { command: 'npm run build && npm test', output: 'npm error Lifecycle script `build` failed\n', exit: 1 },
      { command: 'npm run build && npm test', output: 'built\nTests:       1 failed, 4 passed, 5 total\n', exit: 1 },
    ],
    expected: [
      { kind: 'event', text: 'Build succeeded: npm run build', event: { type: 'build', ok: true, ref: 'npm run build' } },
      { kind: 'event', text: 'Tests passed: npm test (5 tests)', event: { type: 'test', ok: true, ref: 'npm test', count: 5 } },
      { kind: 'event', text: 'Tests failed: npm test (1 of 5 failed)', event: { type: 'test', ok: false, ref: 'npm test', count: 5 } },
    ],
  },
]

for (const [source, run] of Object.entries(SOURCES)) {
  describe(source, () => {
    for (const { name, calls, root, expected } of CASES) {
      test(name, () => {
        expect(posted(run(calls, root))).toEqual(expected)
      })
    }

    test('commands that are no commit, push, submit, build or test make nothing', () => {
      const calls: Call[] = [
        { command: 'git status', output: 'On branch main\nnothing to commit, working tree clean\n' },
        { command: 'git log --oneline -3', output: '4f2a9c1 Add the hero rig\n0a0a0a0 Start\n' },
        { command: 'git fetch', output: 'From github.com:jam/hero\n * branch            main       -> FETCH_HEAD\n' },
        { command: 'p4 opened', output: '//depot/Hero/Content/Maps/Main.umap#3 - edit default change (binary+l)\n' },
        { command: 'cat build.log', output: 'Result: Failed\n[main 4f2a9c1] Add\n 1 file changed\n//depot/A.uasset#1 - opened for edit\n' },
        { command: 'echo make', output: 'make\n' },
        { command: 'bun install', output: 'installed 3 packages\n' },
        { command: 'ls', output: '' },
      ]
      expect(run(calls, POSIX_ROOT)).toEqual([])
    })
  })
}

describe('detect', () => {
  test('a call that never ran makes nothing, even a build', () => {
    expect(detect('npm run build', "The user doesn't want to proceed with this tool use.", true)).toEqual([])
    expect(detect('npm run build', 'Command timed out after 2m 0.0s', true)).toEqual([])
    expect(detect('npm run build', 'Command running in background with ID: b1. Output is being written to: /tmp/b1', false)).toEqual([])
    expect(detect('npm run build', 'PreToolUse:Bash hook error: blocked', true)).toEqual([])
  })

  test('a long submit cut from the result still names its change', () => {
    const files = Array.from({ length: 300 }, (_, i) => `edit //depot/Hero/Content/Props/SM_Rock${i}.uasset#2`).join('\n')
    const output = `Submitting change 1300.\nLocking 300 files ...\n${files}`.slice(0, 4000)
    const [submit, release] = detect('p4 submit -c 1300', output, false, POSIX_ROOT)
    expect(submit.event).toEqual({ type: 'submit', ok: true, ref: '1300', count: 300 })
    expect(release.event.paths?.[0]).toBe('Content/Props/SM_Rock0.uasset')
    expect(release.text).toMatch(/and \d+ more$/)
  })

  test('only the parsed fields leave: no remote address, no output line', () => {
    const output = 'remote: Resolving deltas\nTo https://ana:ghp_secret@github.com/jam/hero.git\n   0a0a0a0..2222222  main -> main\n'
    const json = JSON.stringify(detect('git push', output, false))
    expect(json).not.toContain('ghp_secret')
    expect(json).not.toContain('github.com')
    expect(json).not.toContain('Resolving')
  })

  test('anything unexpected is skipped', () => {
    for (const command of ['', '"', "'", '\\', '&&', '$(', 'git', 'p4 submit -d', '> out', 'bash -c']) {
      for (const output of ['', 'To x', 'Change  submitted.', '[] ', '\u0000', 'Exit code 1']) {
        expect(() => detect(command, output, true)).not.toThrow()
        expect(() => detect(command, output, false)).not.toThrow()
      }
    }
  })
})

describe('EventDetector', () => {
  test('a history read again posts nothing twice', () => {
    const detector = new EventDetector()
    const entries = [
      { id: 't', ts: '2026-11-04T14:00:00Z', kind: 'tool' as const, toolUseId: 't1', name: 'Bash', summary: 'p4 edit A.uasset' },
      {
        id: 'r',
        ts: '2026-11-04T14:00:01Z',
        kind: 'tool_result' as const,
        toolUseId: 't1',
        text: '//depot/A.uasset#1 - opened for edit',
        isError: false,
      },
    ]
    expect(detector.read(entries)).toHaveLength(1)
    expect(detector.read(entries)).toEqual([])
  })

  test("a subagent's commands count, and the post has the time of the result", () => {
    const detector = new EventDetector()
    const [found] = detector.read([
      { id: 's', ts: '2026-11-04T14:00:00Z', kind: 'sub_tool', parent: 'task', toolUseId: 's1', name: 'Bash', summary: 'cargo build' },
      { id: 'r', ts: '2026-11-04T14:00:09Z', kind: 'sub_result', parent: 'task', toolUseId: 's1', text: 'Finished', isError: false },
    ])
    expect(found).toEqual({
      kind: 'event',
      ts: '2026-11-04T14:00:09Z',
      text: 'Build succeeded: cargo build',
      event: { type: 'build', ok: true, ref: 'cargo build' },
    })
  })

  test('other tools are not read', () => {
    const detector = new EventDetector()
    const entries = [
      { id: 't', ts: '2026-11-04T14:00:00Z', kind: 'tool' as const, toolUseId: 't1', name: 'Read', summary: 'make' },
      { id: 'r', ts: '2026-11-04T14:00:01Z', kind: 'tool_result' as const, toolUseId: 't1', text: 'all: hero', isError: false },
    ]
    expect(detector.read(entries)).toEqual([])
  })
})

describe('commands', () => {
  const programs = (line: string) => commandsOf(line).map(command => [command.program, ...command.args])

  test('quotes, operators and redirections, as a shell reads them', () => {
    expect(programs(`cd "my dir" && FOO=1 make -j 8 2>&1 | tee 'build log.txt'; npm test > out.txt`)).toEqual([
      ['cd', 'my dir'],
      ['make', '-j', '8'],
      ['tee', 'build log.txt'],
      ['npm', 'test'],
    ])
  })

  test('Windows paths keep their backslashes, and shells run the command in their argument', () => {
    expect(programs('cmd /c "C:\\UE\\Engine\\Build\\BatchFiles\\Build.bat HeroEditor Win64 Development"')).toEqual([
      ['build', 'HeroEditor', 'Win64', 'Development'],
    ])
    expect(programs(`powershell -Command "& 'C:\\UE\\RunUAT.bat' BuildCookRun -platform=Win64"`)).toEqual([
      ['runuat', 'BuildCookRun', '-platform=Win64'],
    ])
    expect(programs('bash -c "git push origin main"')).toEqual([['git', 'push', 'origin', 'main']])
  })
})

describe('paths', () => {
  test('Windows and POSIX paths are the same path', () => {
    expect(normalizePath('Content\\Maps\\Main.umap')).toBe('Content/Maps/Main.umap')
    expect(normalizePath('./Content/Maps/Main.umap')).toBe('Content/Maps/Main.umap')
    expect(normalizePath('//depot/Hero/Content/Main.umap#3')).toBe('//depot/Hero/Content/Main.umap')
    expect(normalizePath('Content/UI/icon@2x.png')).toBe('Content/UI/icon@2x.png')
  })

  test('relative to the project, local or depot', () => {
    expect(projectPath('C:\\Jam\\Hero\\Content\\Maps\\Main.umap', WINDOWS_ROOT)).toBe('Content/Maps/Main.umap')
    expect(projectPath('c:/jam/hero/Content/Maps/Main.umap', WINDOWS_ROOT)).toBe('Content/Maps/Main.umap')
    expect(projectPath('/Users/ana/jam/Hero/Content/Maps/Main.umap', POSIX_ROOT)).toBe('Content/Maps/Main.umap')
    expect(projectPath('//depot/Hero/Content/Maps/Main.umap', POSIX_ROOT)).toBe('Content/Maps/Main.umap')
    expect(projectPath('//depot/Hero/Content/Maps/Main.umap', WINDOWS_ROOT)).toBe('Content/Maps/Main.umap')
    expect(projectPath('/Users/bob/Other/A.uasset', POSIX_ROOT)).toBe('/Users/bob/Other/A.uasset')
    expect(projectPath('//depot/Other/A.uasset', POSIX_ROOT)).toBe('//depot/Other/A.uasset')
  })
})
