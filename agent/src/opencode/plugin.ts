import { FORWARDED_EVENTS } from './events'

/** The file name in OpenCode's plugins folder. */
export const PLUGIN_FILE = 'tonton-claude.js'

/**
 * The plugin OpenCode loads: it starts `tonton opencode` once per OpenCode process and writes it the events it needs, one
 * JSON line each. It must never get in the way of OpenCode, so every failure is swallowed.
 *
 * OpenCode 2 loads `export default { id, setup }` and its events come from `input.event.subscribe()`; OpenCode 1 loads
 * `server` and calls its `event` hook. Each plugin instance of the process shares one bridge.
 */
export function pluginSource(command: string[]): string {
  return `// Tonton Claude: shows this machine's OpenCode sessions in the notch. Written by \`tonton install\`, removed by
// \`tonton uninstall\`. Everything it sees is encrypted by the Tonton agent before it leaves the machine.
import { spawn } from 'node:child_process'

const COMMAND = ${JSON.stringify(command)}
const FORWARDED = new Set(${JSON.stringify(FORWARDED_EVENTS)})
const state = (globalThis.__tontonClaude ??= { bridge: null })

function bridge() {
  if (state.bridge && state.bridge.exitCode === null && !state.bridge.killed) return state.bridge
  const child = spawn(COMMAND[0], COMMAND.slice(1), { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  child.on('error', () => {})
  child.stdin.on('error', () => {})
  state.bridge = child
  return child
}

function forward(event) {
  if (!event || !FORWARDED.has(event.type)) return
  try {
    bridge().stdin.write(JSON.stringify(event) + '\\n')
  } catch {}
}

export default {
  id: 'tonton-claude',
  setup: async input => {
    ;(async () => {
      try {
        for await (const event of input.event.subscribe({})) forward(event)
      } catch {}
    })()
    return {}
  },
  server: async () => ({ event: async ({ event }) => forward(event) }),
}
`
}
