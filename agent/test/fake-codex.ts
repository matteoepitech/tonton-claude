// A stand-in for the `codex` command in tests, run as `bun fake-codex.ts <args>`:
// - `app-server --listen unix://PATH` serves WebSocket JSON-RPC on the socket, and tells every connection about each
//   thread started, as Codex does;
// - `--remote unix://PATH [args]` plays the TUI: it asks Codex's trust question first with $FAKE_CODEX_TRUST, starts a
//   thread in its folder, writes its args to $FAKE_CODEX_OUT, and exits.

import { appendFileSync } from 'node:fs'
import type { ServerWebSocket } from 'bun'
import { CodexAppServer } from '../src/codex/app-server'

const args = process.argv.slice(2)

if (args[0] === 'app-server') {
  const socket = (args[args.indexOf('--listen') + 1] ?? '').replace(/^unix:\/\//, '')
  const clients = new Set<ServerWebSocket<unknown>>()
  let threads = 0
  Bun.serve({
    unix: socket,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('WebSocket only', { status: 400 })),
    websocket: {
      open: ws => void clients.add(ws),
      close: ws => void clients.delete(ws),
      message(ws, raw) {
        const message = JSON.parse(String(raw))
        if (message.method === 'initialize') ws.send(JSON.stringify({ id: message.id, result: { userAgent: 'codex/0.142.2' } }))
        if (message.method === 'thread/start') {
          const thread = {
            id: `thread-${++threads}`,
            cwd: message.params?.cwd,
            path: `/sessions/rollout-${threads}.jsonl`,
            status: { type: 'idle' },
          }
          ws.send(JSON.stringify({ id: message.id, result: { thread } }))
          for (const client of clients) client.send(JSON.stringify({ method: 'thread/started', params: { thread } }))
        }
      },
    },
  })
} else if (args[0] === '--remote') {
  const socket = (args[1] ?? '').replace(/^unix:\/\//, '')
  if (process.env.FAKE_CODEX_TRUST) {
    // As Codex's onboarding draws its question, then waits for Enter.
    console.log(
      '\n  Trust this folder? Codex can read, edit, and run files here.\n\n› 1. Trust and continue\n  2. Keep current directory\n',
    )
    for await (const _ of console) break
  }
  const tui = await CodexAppServer.connect(socket, '0.142.2')
  await tui.request('thread/start', { cwd: process.cwd() })
  if (process.env.FAKE_CODEX_OUT) appendFileSync(process.env.FAKE_CODEX_OUT, `${JSON.stringify(args.slice(2))}\n`)
  await Bun.sleep(Number(process.env.FAKE_CODEX_STAY_MS ?? 300))
  tui.close()
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0))
} else {
  if (process.env.FAKE_CODEX_OUT) appendFileSync(process.env.FAKE_CODEX_OUT, `plain ${JSON.stringify(args)}\n`)
  process.exit(0)
}
