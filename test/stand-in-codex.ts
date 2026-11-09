// A stand-in for `tonton codex` and the Codex it runs, for the pool tests: the tmux pane of a Codex pool machine's
// session runs it instead. It plays the app-server on a unix socket, records it where `tonton codex` records its server,
// with the thread it starts in its folder, and spawns the real Tonton channel over MCP as Codex would (`channel codex`,
// a child of the server). Like Codex, it lists the channel's tools once, at the start. What reaches the thread
// (`turn/start`, `turn/steer`) is what the channel hands Codex: a pool task there makes it do what Codex would: claim
// it, commit a file on the task's branch in its worktree, push it, and call task_done.
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const home = process.env.TONTON_HOME as string
const agent = join(import.meta.dir, '../agent/src/main.ts')
const threadId = `codex-thread-${process.pid}-${Date.now()}`
const notes = join(home, 'stand-in', `${threadId}.log`)
mkdirSync(join(home, 'stand-in'), { recursive: true })
const note = (line: string) => appendFileSync(notes, `${line}\n`)
// `-lic "'…/tonton' codex -m gpt-5.4"`, as the launcher runs `tonton codex` with the task's model.
const model = /(?:^|\s)-m (\S+)/.exec(process.argv.slice(2).join(' '))?.[1]
note(`thread ${threadId} in ${process.cwd()}${model ? ` on ${model}` : ''}`)

function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: process.cwd(), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
  note(`git ${args[0]}: ${result.exitCode}`)
}

// The socket's path must stay short (104 bytes on macOS): the test gives a folder of its own.
const socket = join(process.env.STAND_IN_SOCKETS ?? join(home, 'run', 'codex'), `${process.pid}.sock`)
let working = false
const server = Bun.serve({
  unix: socket,
  fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('WebSocket only', { status: 400 })),
  websocket: {
    message(ws, raw) {
      const message = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown> }
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: message.id, result }))
      if (message.method === 'initialize') reply({ userAgent: 'codex/0.142.2' })
      else if (message.method === 'thread/resume') reply({ thread: { id: threadId, turns: [] }, ...(model ? { model } : {}) })
      else if (message.method === 'turn/start' || message.method === 'turn/steer') {
        reply(message.method === 'turn/start' ? { turn: { id: 'turn-1', status: 'inProgress' } } : { turnId: 'turn-1' })
        const input = (message.params?.input ?? []) as { type: string; text?: string }[]
        for (const part of input) if (part.type === 'text' && part.text) void prompted(part.text)
      } else if (message.id !== undefined && message.method) reply({})
    },
  },
})

// As `tonton codex` records its server: the channel finds the thread and the socket by its parent, this process.
mkdirSync(join(home, 'run', 'codex'), { recursive: true })
const thread = { id: threadId, cwd: realpathSync(process.cwd()), path: join(home, 'stand-in', `${threadId}.jsonl`) }
writeFileSync(
  join(home, 'run', 'codex', `${process.pid}.json`),
  JSON.stringify({ socket, serverPid: process.pid, wrapperPid: process.pid, startedAt: new Date().toISOString(), threads: [thread] }),
)

const codex = new Client({ name: 'codex-mcp-client', title: 'Codex', version: '0.142.2' })
await codex.connect(new StdioClientTransport({ command: process.execPath, args: [agent, 'channel', 'codex'], env: { ...process.env } }))
// Codex lists them once: the pool's tools are there before the session is in a pool.
note(`tools: ${(await codex.listTools()).tools.map(tool => tool.name).join(' ')}`)

const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await codex.callTool({ name, arguments: args })) as { content: { text: string }[] }
  const text = result.content[0]?.text ?? ''
  note(`${name}: ${text.split('\n')[0]}`)
  return text
}

async function prompted(content: string) {
  note(`delivered: ${content}`)
  const task = /<pool kind="task"[^>]* task="([^"]+)"/.exec(content)?.[1]
  const branch = /Branch: (pool\/\S+)\./.exec(content)?.[1]
  if (!task || working) return
  working = true
  await call('task_claim', { task })
  writeFileSync(join(process.cwd(), `${task}.md`), 'Done by the Codex stand-in.\n')
  git('add', '.')
  git('commit', '-m', `codex work on ${task}`)
  git('push', '-u', 'origin', branch ?? 'HEAD')
  await call('task_done', { task, summary: 'Codex wrote the file.', branch, tests: 'none: a stand-in' })
  working = false
}

process.on('SIGHUP', () => {
  server.stop(true)
  process.exit(129)
})
console.log(`Codex stand-in running ${threadId}`)
await new Promise(() => {})
