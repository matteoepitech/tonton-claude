// A stand-in for Claude Code, for test/pool-workers.test.ts: the tmux pane of a pool machine's session runs it instead
// of claude. It asks the two questions Claude Code asks on starting, links its session the way the hooks do, and spawns
// the real Tonton channel over MCP, as Claude Code would. When a pool task arrives through the channel, it does what
// Claude would: claims it, commits a file on the task's branch in its worktree, pushes it, and calls task_done. A task
// whose title says "crash" makes it exit instead, like a session that ends before its task is done.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const home = process.env.TONTON_HOME as string
const agent = join(import.meta.dir, '../agent/src/main.ts')
const sessionId = `stand-in-${process.pid}-${Date.now()}`
const notes = join(home, 'stand-in', `${sessionId}.log`)
mkdirSync(join(home, 'stand-in'), { recursive: true })
const note = (line: string) => appendFileSync(notes, `${line}\n`)

const lines = (async function* () {
  let buffered = ''
  for await (const chunk of process.stdin) {
    buffered += chunk.toString()
    while (buffered.includes('\n') || buffered.includes('\r')) {
      const end = buffered.search(/[\r\n]/)
      yield buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
    }
  }
})()

function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: process.cwd(), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
  note(`git ${args[0]}: ${result.exitCode}`)
}

console.log('WARNING: Loading development channels')
await lines.next()
console.log('Quick safety check: Is this a project you created or one you trust?')
await lines.next()

// What the hooks write for the channel, named after this process.
const transcript = join(home, 'stand-in', `${sessionId}.jsonl`)
writeFileSync(transcript, `${JSON.stringify({ sessionId, type: 'user', uuid: 'u1', message: { content: 'ready' } })}\n`)
mkdirSync(join(home, 'run'), { recursive: true })
writeFileSync(join(home, 'run', `${process.pid}.json`), JSON.stringify({ sessionId, transcriptPath: transcript, cwd: process.cwd() }))
// What Claude Code's status line says of the model it was started with (`claude --model sonnet`), as agent/src/usage.ts
// keeps it: the full id of an alias's family.
const asked = /--model (\S+)/.exec(process.argv.slice(2).join(' '))?.[1]
if (asked) {
  const model = asked.startsWith('claude-') ? asked : `claude-${asked}-stand-in`
  writeFileSync(join(home, 'run', `usage-${sessionId}.json`), JSON.stringify({ model }))
}
note(`session ${sessionId} in ${process.cwd()}${asked ? ` on ${asked}` : ''}`)

const claude = new Client({ name: 'claude-code', version: 'stand-in' })
await claude.connect(
  new StdioClientTransport({ command: process.execPath, args: [agent, 'channel'], env: { ...process.env, TONTON_CHANNEL: '1' } }),
)
const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await claude.callTool({ name, arguments: args })) as { content: { text: string }[] }
  note(`${name}: ${result.content[0]?.text.split('\n')[0]}`)
}

claude.fallbackNotificationHandler = async notification => {
  const content = String((notification.params as { content?: unknown } | undefined)?.content ?? '')
  note(`delivered: ${content}`)
  // Made the orchestrator of a pool on autopilot: it plans one task and starts the dispatch, as the user asked.
  if (/<pool kind="role"/.test(content) && content.includes('runs on autopilot')) {
    await call('task_create', {
      title: 'SECRET landing page',
      goal: 'A landing page that says what the shop sells, with a form to sign up for the launch.',
      criteria: ['the page says what the shop sells', 'the form takes an email'],
      size: 'large',
    })
    await call('dispatch_start', { note: 'Go' })
    return
  }
  const task = /<pool kind="task"[^>]* task="([^"]+)"/.exec(content)?.[1]
  const branch = /Branch: (pool\/\S+)\./.exec(content)?.[1]
  if (!task) return
  if (/crash/i.test(content)) process.exit(1)
  await call('task_claim', { task })
  writeFileSync(join(process.cwd(), `${task}.md`), 'Done by the stand-in.\n')
  git('add', '.')
  git('commit', '-m', `work on ${task}`)
  git('push', '-u', 'origin', branch ?? 'HEAD')
  await call('task_done', { task, summary: 'Wrote the file.', branch, tests: 'none: a stand-in' })
}

console.log(`Running as ${sessionId}`)
// Like Claude Code, it runs until its terminal goes.
await new Promise(() => {})
