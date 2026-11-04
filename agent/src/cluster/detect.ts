// What a session's shell commands tell its cluster without anyone posting (#311): commits, pushes, Perforce submits and
// shelves, builds and test runs, and the files it opens in Perforce or locks in Git LFS (#310). Read from the tool calls
// and results the agent already parses, Claude Code's and OpenCode's alike; the agent never runs git or p4 itself.
// Only the fields below leave the machine, sealed, never the output they come from. Command output is no more a public
// format than the transcripts: what isn't recognized is skipped, never thrown.

import { isAbsolute, relative } from 'node:path'
import type { Entry } from '../../../shared/protocol'

/** The `event` of a cluster post, as `ClusterEvent` in `shared/cluster-protocol.ts` (#307) has it. */
export interface DetectedEvent {
  /** `commit`, `push`, `submit`, `shelve`, `build`, `test`, and `claim` or `release` for files. */
  type: string
  ok?: boolean
  /** The branch of a push, the commit of a commit, the changelist of a submit or shelve, what a build or a test ran. */
  ref?: string
  /** Relative to the project when they are under it, with `/`; depot paths otherwise. */
  paths?: string[]
  /** Commits pushed, files committed, submitted or shelved, tests run. */
  count?: number
}

/** A post to make: `event`, or `claim` for files held or let go. `ts` is the time of the tool result. */
export interface Detected {
  kind: 'event' | 'claim'
  ts: string
  text: string
  event: DetectedEvent
}

/** What the text says and the fields don't. */
interface Found {
  event: DetectedEvent
  /** The local branch of a commit, or the one a push sent. */
  branch?: string
  /** The first line of a commit, the description of a submit. */
  subject?: string
  reason?: string
  /** The command that took or let go of files: `p4 edit`, `git lfs unlock`. */
  via?: string
  passed?: number
  failed?: number
}

const MAX_PATHS = 100
const MAX_SUBJECT_CHARS = 200
const MAX_REF_CHARS = 120
/** Calls waiting for their result, and calls already read: a session's history can be read again. */
const MAX_PENDING = 200
const MAX_DONE = 2000
/** The tools that run commands: OpenCode's `bash` and `shell` come as `Bash` (agent/src/opencode/events.ts). */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** Reads one session's entries as they come, and keeps what a push needs: the commits made since the last one. */
export class EventDetector {
  private readonly pending = new Map<string, string>()
  private readonly done = new Set<string>()
  /** Per local branch, the commits this session made and has not pushed yet, and the last one's first line. */
  private readonly unpushed = new Map<string, { count: number; subject?: string }>()

  /** `root`: the session's project folder, for paths relative to it. */
  constructor(private readonly root?: string) {}

  read(entries: Entry[]): Detected[] {
    const detected: Detected[] = []
    for (const entry of entries) {
      if ((entry.kind === 'tool' || entry.kind === 'sub_tool') && SHELL_TOOLS.has(entry.name)) {
        if (this.done.has(entry.toolUseId)) continue
        this.pending.set(entry.toolUseId, entry.summary)
        if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value ?? '')
      } else if (entry.kind === 'tool_result' || entry.kind === 'sub_result') {
        const command = this.pending.get(entry.toolUseId)
        if (command === undefined) continue
        this.pending.delete(entry.toolUseId)
        this.done.add(entry.toolUseId)
        if (this.done.size > MAX_DONE) this.done.delete(this.done.values().next().value ?? '')
        for (const found of findEvents(command, entry.text, entry.isError, this.root)) {
          detected.push({ ...post(this.count(found)), ts: entry.ts })
        }
      }
    }
    return detected
  }

  /** A push only names its branch: the commits it sent are the ones this session made on it since the last push. */
  private count(found: Found): Found {
    const { event, branch } = found
    if (event.type === 'commit' && branch) {
      this.unpushed.set(branch, { count: (this.unpushed.get(branch)?.count ?? 0) + 1, subject: found.subject })
    }
    if (event.type === 'push' && event.ok && event.ref) {
      const commits = (branch ? this.unpushed.get(branch) : undefined) ?? this.unpushed.get(event.ref)
      if (branch) this.unpushed.delete(branch)
      this.unpushed.delete(event.ref)
      if (commits) return { ...found, event: { ...event, count: commits.count }, subject: commits.subject }
    }
    return found
  }
}

/**
 * The posts one shell call makes: `command` as the entry's summary has it (one line, maybe cut), `output` its result,
 * `isError` set when it exited with an error. A call that never ran (refused, interrupted, timed out) makes none.
 */
export function detect(command: string, output: string, isError: boolean, root?: string): Omit<Detected, 'ts'>[] {
  return findEvents(command, output, isError, root).map(post)
}

function post(found: Found): Omit<Detected, 'ts'> {
  const { type } = found.event
  return { kind: type === 'claim' || type === 'release' ? 'claim' : 'event', text: textOf(found), event: found.event }
}

function findEvents(command: string, output: string, isError: boolean, root?: string): Found[] {
  try {
    if (didNotRun(output, isError)) return []
    const commands = commandsOf(command)
    return [...vcsEvents(commands, command, output, isError, root), ...runEvents(commands, output, isError)]
  } catch {
    return []
  }
}

/** Claude Code starts the result of a command that ran and failed with its exit code; other errors came before it ran. */
function didNotRun(output: string, isError: boolean): boolean {
  if (/^Command running in background/i.test(output)) return true
  if (!isError || /^Exit code \d+/.test(output)) return false
  return /^\s*(\[?Request interrupted|Interrupted|The user|User |Error: The user|Permission|Command timed out|Tool execution|The operation was aborted|.*\bhook\b)/i.test(
    output,
  )
}

// Commands

interface Command {
  /** The program's name, lower case, without folder or extension: `git`, `p4`, `runuat`, `unrealbuildtool`. */
  program: string
  /** As written, folder and extension included. */
  word: string
  args: string[]
}

const WRAPPERS = new Set(['sudo', 'time', 'env', 'nice', 'nohup', 'command', 'exec', 'npx', 'bunx', 'pnpx', 'call', 'start'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh'])
const SHELL_COMMAND_FLAGS = new Set(['-c', '/c', '/k', '-command'])

/** A command line cut into simple commands the way a shell reads it: quotes, `&&`, `||`, `;`, `|`, redirections. */
export function commandsOf(line: string, depth = 0): Command[] {
  const commands: Command[] = []
  for (const words of wordsOf(line)) {
    let at = 0
    while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || WRAPPERS.has(programName(words[at])))) at++
    if (at >= words.length) continue
    const word = words[at]
    const program = programName(word)
    const args = words.slice(at + 1)
    // `bash -c "…"`, `cmd /c …`, `powershell -Command "…"`: the command is in the argument.
    const flag = args.findIndex(arg => SHELL_COMMAND_FLAGS.has(arg.toLowerCase()))
    if (SHELLS.has(program) && flag >= 0 && depth < 2) commands.push(...commandsOf(args.slice(flag + 1).join(' '), depth + 1))
    else commands.push({ program, word, args })
  }
  return commands
}

/** Backslashes stay unless they escape something a shell would read: Windows paths keep theirs. */
const ESCAPABLE = ` '"&|;()<>$\\`

function wordsOf(line: string): string[][] {
  const lists: string[][] = []
  let words: string[] = []
  let word: string | null = null
  // The word after `>` or `<` is a file, not an argument.
  let redirected = false
  const end = () => {
    if (word !== null && redirected) redirected = false
    else if (word !== null) words.push(word)
    word = null
  }
  const split = () => {
    end()
    if (words.length) lists.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      const stop = close < 0 ? line.length : close
      word = (word ?? '') + line.slice(i + 1, stop)
      i = stop
    } else if (c === '"') {
      let j = i + 1
      let quoted = ''
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && '"\\$`'.includes(line[j + 1] ?? '.')) j++
        quoted += line[j]
      }
      word = (word ?? '') + quoted
      i = j
    } else if (/\s/.test(c)) {
      end()
    } else if (c === '\\' && i + 1 < line.length && ESCAPABLE.includes(line[i + 1])) {
      word = (word ?? '') + line[i + 1]
      i++
    } else if (c === '>' || c === '<') {
      // The 2 of `2>&1` is no argument either.
      if (word !== null && /^\d+$/.test(word)) word = null
      end()
      while ('<>&'.includes(line[i + 1] ?? '.')) i++
      redirected = true
    } else if (c === '$' && line[i + 1] === '(') {
      split()
      i++
    } else if ('&|;()\n'.includes(c)) {
      split()
      if (line[i + 1] === c) i++
    } else {
      word = (word ?? '') + c
    }
  }
  split()
  return lists
}

function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|bat|cmd|sh|ps1|command|dll)$/i, '').toLowerCase()
}

const positional = (args: string[]) => args.filter(arg => !/^[-/+]/.test(arg))

/** The subcommand of git or p4, past the options before it and the values some of them take. */
function subcommandOf(command: Command, valued: Set<string>): { name: string; args: string[] } | null {
  for (let i = 0; i < command.args.length; i++) {
    const arg = command.args[i]
    if (valued.has(arg)) i++
    else if (!arg.startsWith('-')) return { name: arg.toLowerCase(), args: command.args.slice(i + 1) }
  }
  return null
}

const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const P4_VALUED = new Set(['-c', '-C', '-d', '-H', '-p', '-P', '-u', '-x', '-z', '-r', '-Q', '-L', '-b'])

// Git and Perforce: the output says what happened, the command only that it was git or p4. A summary is cut at 300
// characters, so the `git push` after a long commit message can be missing from it while its output is there.

function vcsEvents(commands: Command[], line: string, output: string, isError: boolean, root?: string): Found[] {
  const git = commands.filter(command => command.program === 'git').map(command => subcommandOf(command, GIT_VALUED)?.name)
  const p4 = commands.filter(command => command.program === 'p4').map(command => subcommandOf(command, P4_VALUED))
  const lfs = git.includes('lfs') || commands.some(command => command.program === 'git-lfs')
  const found: Found[] = []
  if (git.length) found.push(...commits(output), ...pushes(output, git.includes('push') || line.endsWith('…')))
  if (lfs) found.push(...lfsLocks(output, root))
  if (p4.length) {
    found.push(
      ...perforce(
        output,
        isError,
        p4.filter(sub => sub !== null),
        root,
      ),
    )
  }
  return found
}

/** `[main 1a2b3c4] Add the hero` then ` 3 files changed, …`: what amend, cherry-pick and revert print too. */
function commits(output: string): Found[] {
  return [...output.matchAll(/^\[(.+?) ([0-9a-f]{7,40})\] (.*)\n(?:.*\n){0,3}? (\d+) files? changed/gm)].map(match => {
    const branch = match[1].replace(/\s*\(root-commit\)/, '').trim()
    return {
      event: { type: 'commit', ok: true, ref: match[2], count: Number(match[4]) },
      branch: branch && !branch.startsWith('detached') ? branch : undefined,
      subject: cut(match[3].trim(), MAX_SUBJECT_CHARS),
    }
  })
}

/**
 * `To <remote>`, then a line per ref: `   1a2b3c4..5d6e7f8  main -> main`, ` * [new branch]  feat -> feat`,
 * ` ! [rejected]  main -> main (fetch first)`. The remote's address stays on the machine: it can hold a token.
 */
function pushes(output: string, pushed: boolean): Found[] {
  const to = /^To \S+$/m.exec(output)
  if (!to) return []
  const found: Found[] = []
  for (const match of output.slice(to.index).matchAll(/^ ([ +*=!-]) (\[[^\]]+\]|\S+)\s+(\S+) -> (\S+)(?: \(([^)\n]*)\))?\s*$/gm)) {
    const [, flag, summary, source, target, reason] = match
    const ok = flag !== '!'
    // Up to date, or a rejection read from a command that may not have pushed.
    if (flag === '=' || (!ok && !pushed)) continue
    const branch = (ref: string) => cut(ref.replace(/^refs\/heads\//, ''), MAX_REF_CHARS)
    found.push({
      event: { type: 'push', ok, ref: branch(target) },
      branch: branch(source),
      ...(ok ? {} : { reason: cut(reason ?? summary.replace(/[[\]]/g, ''), MAX_REF_CHARS) }),
    })
  }
  return found
}

/** `Locked Content/Maps/Main.umap`, `Unlocked …`: the path as Git LFS keeps it, relative to the repository. */
function lfsLocks(output: string, root?: string): Found[] {
  const found: Found[] = []
  const locked = pathsOf(output, /^Locked (.+?)\s*$/gm, root)
  const unlocked = pathsOf(output, /^Unlocked (.+?)\s*$/gm, root)
  if (locked.length) found.push({ event: { type: 'claim', paths: locked }, via: 'git lfs lock' })
  if (unlocked.length) found.push({ event: { type: 'release', paths: unlocked }, via: 'git lfs unlock' })
  return found
}

/** Perforce's own lines, also after the `info:` that `p4 -s` puts in front. */
const P4_OPENED = /^(?:info\d?: )?(\/\/[^#\n]+)#(?:\d+|none) - (?:currently )?opened for (edit|add|delete|move\/add|move\/delete)/gm
const P4_REVERTED = /^(?:info\d?: )?(\/\/[^#\n]+)#(?:\d+|none) - was \S+, (?:reverted|abandoned|deleted)/gm
const P4_FILE = /^(?:info\d?: )?(?:edit|add|delete|branch|integrate|move\/add|move\/delete|import|purge|archive) (\/\/[^#\n]+)#\d+\s*$/gm

function perforce(output: string, isError: boolean, subs: { name: string; args: string[] }[], root?: string): Found[] {
  const found: Found[] = []
  for (const action of ['edit', 'add', 'delete']) {
    const paths = pathsOf(output, P4_OPENED, root, match => match[2].endsWith(action))
    if (paths.length) found.push({ event: { type: 'claim', paths }, via: `p4 ${action}` })
  }

  const submit = subs.find(sub => sub.name === 'submit')
  const submitted = /^(?:info\d?: )?Change (\d+) (?:renamed change (\d+) and )?submitted\./m.exec(output)
  const aborted = /^Submit aborted|^No files to submit|must resolve|Out of date files/m.test(output)
  // The last line of a long submit can be cut from the result: its start says which change it was.
  const submitting = isError || aborted ? null : /^(?:info\d?: )?Submitting change (\d+)\./m.exec(output)
  if (submitted || submitting) {
    const change = submitted ? (submitted[2] ?? submitted[1]) : (submitting?.[1] ?? '')
    const paths = pathsOf(output, P4_FILE, root)
    const description = submit ? flagValue(submit.args, '-d') : undefined
    found.push({
      event: { type: 'submit', ok: true, ref: change, count: fileCount(output) ?? paths.length },
      subject: description ? cut(description.split('\n')[0].trim(), MAX_SUBJECT_CHARS) : undefined,
    })
    if (paths.length) found.push({ event: { type: 'release', paths, ref: change }, via: 'p4 submit' })
  } else if (submit && (isError || aborted)) {
    const change = flagValue(submit.args, '-c') ?? /p4 submit -c (\d+)/.exec(output)?.[1]
    found.push({
      event: { type: 'submit', ok: false, ...(change && /^\d+$/.test(change) ? { ref: change } : {}) },
      reason: submitFailure(output),
    })
  }

  const shelved = /^(?:info\d?: )?Change (\d+) files shelved\./m.exec(output)
  if (shelved) {
    found.push({ event: { type: 'shelve', ok: true, ref: shelved[1], count: fileCount(output) ?? [...output.matchAll(P4_FILE)].length } })
  } else if (subs.some(sub => sub.name === 'shelve') && (isError || /^No files to shelve/m.test(output))) {
    found.push({ event: { type: 'shelve', ok: false } })
  }

  const reverted = pathsOf(output, P4_REVERTED, root)
  if (reverted.length) found.push({ event: { type: 'release', paths: reverted }, via: 'p4 revert' })
  return found
}

/** Why a submit failed, in words of ours: Perforce's lines name files and people. */
function submitFailure(output: string): string {
  if (/must resolve|must be resolved/i.test(output)) return 'files to resolve first'
  if (/No files to submit/i.test(output)) return 'nothing to submit'
  if (/exclusive|locked by/i.test(output)) return 'files locked by someone else'
  if (/trigger/i.test(output)) return 'a server trigger refused it'
  return 'it failed'
}

/** `Change 1234 created with 3 open file(s).` or `Locking 3 files ...`: near the start, so never cut. */
function fileCount(output: string): number | undefined {
  const match = /created with (\d+) open file|^(?:info\d?: )?Locking (\d+) files?/m.exec(output)
  return match ? Number(match[1] ?? match[2]) : undefined
}

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined
}

// Builds and tests: the command says what ran, its exit code and its output whether it worked.

interface Run {
  type: 'build' | 'test'
  /** What it ran: `UnrealBuildTool HeroEditor Win64 Development`, `npm run build`. */
  ref: string
}

const TEST_RUNNERS = new Set(['jest', 'vitest', 'mocha', 'pytest', 'py.test'])
/** Make targets that build nothing. */
const CHORES = /^(clean|distclean|install|uninstall|format|fmt|lint|help|run|dev|serve|watch)$/
const UNREAL_PLATFORMS = /^(win64|mac|linux|linuxarm64|android|ios|tvos|visionos)$/i

function runOf(command: Command): Run | null {
  const { program, word, args } = command
  const lower = args.map(arg => arg.toLowerCase())
  const named = (...words: string[]) => cut(words.join(' '), MAX_REF_CHARS)
  // Target, platform and configuration: `HeroEditor Win64 Development`.
  const ubt = (list: string[]): Run => ({
    type: 'build',
    ref: named(
      'UnrealBuildTool',
      ...positional(list)
        .filter(arg => !/[\\/]|\.uproject$/i.test(arg))
        .slice(0, 3),
    ),
  })

  if (program === 'unrealbuildtool') return ubt(args)
  if ((program === 'build' || program === 'runubt') && (/batchfiles/i.test(word) || args.some(arg => UNREAL_PLATFORMS.test(arg)))) {
    return ubt(args)
  }
  if (program === 'build' && /\.(bat|cmd|sh|ps1|command)$/i.test(word)) return { type: 'build', ref: word.split(/[\\/]/).pop() ?? word }
  if (program === 'runuat') {
    const name = positional(args)[0] ?? ''
    const option = (key: string) => args.find(arg => arg.toLowerCase().startsWith(`-${key}=`))?.split('=')[1]
    const where = [option('platform'), option('clientconfig') ?? option('configuration')].filter(value => value !== undefined)
    if (/^(buildcookrun|buildgraph|buildplugin|buildtarget)$/i.test(name)) return { type: 'build', ref: named(name, ...where) }
    if (/^(runtests|runautomationtests|runlowleveltests|rununreal)$/i.test(name)) return { type: 'test', ref: named(name, ...where) }
    return null
  }
  if (/^(unrealeditor|ue4editor|ue5editor)(-cmd)?$/.test(program)) {
    if (args.some(arg => /automation\s+run(tests|all|filter)/i.test(arg))) return { type: 'test', ref: 'Unreal automation tests' }
    if (lower.includes('-run=cook')) return { type: 'build', ref: 'Unreal cook' }
    return null
  }
  if (program === 'dotnet') {
    if (/unrealbuildtool\.dll$/i.test(args[0] ?? '')) return ubt(args.slice(1))
    if (['build', 'publish', 'msbuild', 'pack'].includes(lower[0])) return { type: 'build', ref: `dotnet ${lower[0]}` }
    return lower[0] === 'test' ? { type: 'test', ref: 'dotnet test' } : null
  }
  if (program === 'msbuild') return { type: 'build', ref: 'msbuild' }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) return packageRun(program, args)
  if (program === 'cargo') {
    const sub = positional(args)[0]
    if (sub === 'build' || sub === 'b') return { type: 'build', ref: 'cargo build' }
    if (sub === 'test' || sub === 't' || sub === 'nextest') return { type: 'test', ref: `cargo ${sub === 'nextest' ? 'nextest' : 'test'}` }
    return null
  }
  if (['make', 'gmake', 'mingw32-make', 'nmake', 'ninja'].includes(program)) {
    const targets: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (/^-[CfIoW]$/.test(args[i]) || (/^-[jl]$/.test(args[i]) && /^\d+$/.test(args[i + 1] ?? ''))) i++
      else if (!args[i].startsWith('-') && !args[i].includes('=')) targets.push(args[i])
    }
    if (targets.some(target => /^(test|tests|check)$/.test(target))) return { type: 'test', ref: named(program, ...targets) }
    if (targets.some(target => CHORES.test(target))) return null
    return { type: 'build', ref: named(program, ...targets.slice(0, 3)) }
  }
  if (program === 'cmake') return lower.includes('--build') ? { type: 'build', ref: 'cmake --build' } : null
  if (program === 'ctest') return { type: 'test', ref: 'ctest' }
  if (program === 'go' || program === 'swift') {
    if (lower[0] === 'build') return { type: 'build', ref: `${program} build` }
    return lower[0] === 'test' ? { type: 'test', ref: `${program} test` } : null
  }
  if (program === 'xcodebuild') {
    if (lower.includes('test')) return { type: 'test', ref: 'xcodebuild test' }
    const builds = lower.includes('build') || lower.includes('archive') || (lower.includes('-scheme') && !positional(args).length)
    return builds ? { type: 'build', ref: 'xcodebuild' } : null
  }
  if (program === 'gradle' || program === 'gradlew') {
    const tasks = positional(args)
    if (tasks.some(task => /^(test|check|connected\w*Test)$/.test(task))) return { type: 'test', ref: named('gradle', ...tasks) }
    return tasks.some(task => /^(build|assemble\w*|bundle\w*)$/.test(task)) ? { type: 'build', ref: named('gradle', ...tasks) } : null
  }
  if (program === 'mvn' || program === 'mvnw') {
    const phases = positional(args)
    if (phases.includes('test')) return { type: 'test', ref: 'mvn test' }
    return phases.some(phase => ['compile', 'package', 'verify', 'install'].includes(phase))
      ? { type: 'build', ref: named('mvn', ...phases) }
      : null
  }
  if (TEST_RUNNERS.has(program)) return { type: 'test', ref: program }
  if (/^(python3?|py)$/.test(program) && lower[0] === '-m' && TEST_RUNNERS.has(lower[1])) return { type: 'test', ref: lower[1] }
  return null
}

/** `npm run build`, `bun run build:web`, `yarn build`, `pnpm test`, `bun test`, `npm t`, `pnpm exec vitest`. */
function packageRun(program: string, args: string[]): Run | null {
  const [first, second] = positional(args)
  if (!first) return null
  if (['exec', 'x', 'dlx'].includes(first)) return second ? runOf({ program: programName(second), word: second, args: [] }) : null
  if (program === 'bun' && (first === 'test' || first === 'build')) return { type: first, ref: `bun ${first}` }
  if (first === 't' || first === 'tst') return { type: 'test', ref: `${program} test` }
  const viaRun = first === 'run' || first === 'run-script'
  const script = viaRun ? second : first
  if (!script) return null
  const ref = viaRun ? `${program} run ${script}` : `${program} ${script}`
  if (/^build(:|$)/.test(script)) return { type: 'build', ref }
  if (/^test(:|$)/.test(script) || TEST_RUNNERS.has(script)) return { type: 'test', ref }
  return null
}

/** Lines that say a build or a test run failed, whatever its exit code: `| tail` hides that one. */
const FAILED = [
  /^Result: Failed/m,
  /BUILD (COMMAND )?FAILED/,
  /AutomationTool exiting with ExitCode=[1-9]/,
  /^Build FAILED\./m,
  /error: could not compile/,
  /^\S*make(\[\d+\])?: \*\*\* .*Error \d+/m,
  /^ninja: build stopped/m,
  /^npm (ERR!|error) /m,
  /ERR_PNPM_/,
  /^error Command failed with exit code/m,
  /^error: script ".*" exited with code/m,
  /\*\* (BUILD|TEST) FAILED \*\*/,
  /^test result: FAILED/m,
  /^FAIL\b/m,
  /^Failed!/m,
  /TEST COMPLETE\. EXIT CODE: [1-9]/,
]

function runEvents(commands: Command[], output: string, isError: boolean): Found[] {
  const runs = commands.map(runOf).filter(run => run !== null)
  if (!runs.length) return []
  const tests = runs.filter(run => run.type === 'test')
  const counts = tests.length === 1 ? testCounts(output) : {}
  const failed = isError || FAILED.some(pattern => pattern.test(output)) || (counts.failed ?? 0) > 0
  // When `npm run build && npm test` fails, an exit code can't tell which one did: only failed tests that say so are
  // told, and nothing else rather than the wrong one.
  const told = !failed || runs.length === 1 ? runs : (counts.failed ?? 0) > 0 ? tests : []
  return told.map(run => {
    const known = run.type === 'test' && (counts.passed !== undefined || counts.failed !== undefined)
    return {
      event: { type: run.type, ok: !failed, ref: run.ref, ...(known ? { count: (counts.passed ?? 0) + (counts.failed ?? 0) } : {}) },
      ...(known ? counts : {}),
    }
  })
}

/** The summary line of the common test runners: the first that matches counts. */
function testCounts(output: string): { passed?: number; failed?: number } {
  const number = (pattern: RegExp, text = output) => {
    const match = pattern.exec(text)
    return match ? Number(match[1]) : undefined
  }
  const total = (matches: RegExpMatchArray[], group: number) => matches.reduce((sum, match) => sum + Number(match[group]), 0)
  // bun test: ` 12 pass` and ` 1 fail`, each on its own line.
  const bun = number(/^\s*(\d+) pass\s*$/m)
  if (bun !== undefined) return { passed: bun, failed: number(/^\s*(\d+) fail\s*$/m) ?? 0 }
  // cargo: a line per test binary.
  const cargo = [...output.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm)]
  if (cargo.length) return { passed: total(cargo, 1), failed: total(cargo, 2) }
  // jest `Tests:  1 failed, 5 passed, 6 total`, vitest `Tests  1 failed | 5 passed (6)`, pytest `== 1 failed, 5 passed in 0.3s ==`.
  const line =
    /^\s*Tests:?\s+(.*\d+ (?:passed|failed).*)$/m.exec(output)?.[1] ?? /^=+ (.*\d+ (?:passed|failed).*) in [\d.]+s.*=+$/m.exec(output)?.[1]
  if (line) return { passed: number(/(\d+) passed/, line) ?? 0, failed: number(/(\d+) failed/, line) ?? 0 }
  // dotnet: `Failed!  - Failed:     1, Passed:     9, …`, a line per test project.
  const dotnet = [...output.matchAll(/(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+), Passed:\s+(\d+)/g)]
  if (dotnet.length) return { passed: total(dotnet, 2), failed: total(dotnet, 1) }
  // XCTest: `Executed 12 tests, with 1 failure`, the last line for all of them.
  const xctest = [...output.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)].pop()
  if (xctest) return { passed: Number(xctest[1]) - Number(xctest[2]), failed: Number(xctest[2]) }
  const ctest = /\d+% tests passed, (\d+) tests? failed out of (\d+)/.exec(output)
  if (ctest) return { passed: Number(ctest[2]) - Number(ctest[1]), failed: Number(ctest[1]) }
  return {}
}

// Paths

/** `/` between folders, no `./` in front, no revision after: `.\Content\Maps\Main.umap#3` is `Content/Maps/Main.umap`. */
export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/^["']|["']$/g, '')
  const slashed = trimmed
    .replace(/\\/g, '/')
    .replace(/(#(\d+|none|head|have)|@\d+)$/i, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/(.)\/$/, '$1')
  return trimmed.startsWith('//') ? `/${slashed}` : slashed
}

/**
 * A path as the cluster names it: relative to the project when it is under it. A depot path is read from the project
 * folder's name on: `//depot/Hero/Content/Main.umap`, in a project folder named `Hero`, is `Content/Main.umap`.
 */
export function projectPath(path: string, root?: string): string {
  const normal = normalizePath(path)
  if (!root) return normal
  const base = normalizePath(root)
  if (normal.startsWith('//')) {
    const name = base.split('/').pop()?.toLowerCase()
    const segments = normal.slice(2).split('/')
    const at = segments.findIndex(segment => segment.toLowerCase() === name)
    return at >= 0 && at < segments.length - 1 ? segments.slice(at + 1).join('/') : normal
  }
  // Windows paths compare without case, whatever the platform reading them.
  if (/^[A-Za-z]:\//.test(normal) || /^[A-Za-z]:\//.test(base)) {
    const prefix = `${base.toLowerCase()}/`
    return normal.toLowerCase().startsWith(prefix) ? normal.slice(prefix.length) : normal
  }
  if (!isAbsolute(normal)) return normal
  const inside = relative(base, normal)
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.replace(/\\/g, '/') : normal
}

function pathsOf(output: string, pattern: RegExp, root?: string, keep: (match: RegExpMatchArray) => boolean = () => true): string[] {
  const paths = new Set<string>()
  for (const match of output.matchAll(pattern)) {
    if (paths.size >= MAX_PATHS) break
    if (keep(match) && match[1].trim()) paths.add(projectPath(match[1], root))
  }
  return [...paths]
}

// Text

const CLAIM_TEXT: Record<string, string> = {
  'p4 edit': 'Opened for edit in Perforce:',
  'p4 add': 'Opened for add in Perforce:',
  'p4 delete': 'Opened for delete in Perforce:',
  'git lfs lock': 'Locked in Git LFS:',
  'p4 submit': 'Submitted, no longer held:',
  'p4 revert': 'Reverted in Perforce:',
  'git lfs unlock': 'Unlocked in Git LFS:',
}

/** The line the feed shows and the other sessions read. */
function textOf({ event, branch, subject, reason, via, passed, failed }: Found): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  const files = event.count !== undefined ? ` (${plural(event.count, 'file')})` : ''
  switch (event.type) {
    case 'commit':
      return `Committed ${event.ref}${branch ? ` on ${branch}` : ''}: ${subject ?? ''}${files}`
    case 'push': {
      if (!event.ok) return `Push to ${event.ref} was rejected${reason ? ` (${reason})` : ''}`
      const commits = event.count !== undefined ? `${plural(event.count, 'commit')} ` : ''
      return `Pushed ${commits}to ${event.ref}${subject ? `: ${subject}` : ''}`
    }
    case 'submit':
      if (!event.ok) return `Perforce submit${event.ref ? ` of change ${event.ref}` : ''} failed: ${reason ?? 'it failed'}`
      return `Submitted change ${event.ref} to Perforce${subject ? `: ${subject}` : ''}${files}`
    case 'shelve':
      return event.ok ? `Shelved change ${event.ref} in Perforce${files}` : 'Perforce shelve failed'
    case 'build':
      return `Build ${event.ok ? 'succeeded' : 'failed'}: ${event.ref}`
    case 'test': {
      const counted =
        event.count === undefined ? '' : failed ? ` (${failed} of ${event.count} failed)` : ` (${plural(passed ?? 0, 'test')})`
      return `Tests ${event.ok ? 'passed' : 'failed'}: ${event.ref}${counted}`
    }
    default: {
      const paths = event.paths ?? []
      const shown = paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '')
      return `${CLAIM_TEXT[via ?? ''] ?? event.type} ${shown}`
    }
  }
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
