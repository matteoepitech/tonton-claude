import { ALL_POOL_TOOLS } from '../channel/pool-work'
import { FORWARDED_EVENTS } from './events'

/** The file name in OpenCode's plugins folder. */
export const PLUGIN_FILE = 'tonton-claude.js'

/**
 * The plugin OpenCode loads: it starts `tonton opencode` once per OpenCode process, writes it the events it needs, one
 * JSON line each, and runs in OpenCode what the bridge writes back (see `PluginCommand` in bridge.ts). It must never get
 * in the way of OpenCode, so every failure is swallowed, or told to the bridge.
 *
 * OpenCode 2 loads `export default { id, setup }`: its events come from `input.event.subscribe()` and it acts through
 * `input.session` and `input.permission`, one input per folder it serves. OpenCode 1 loads `server`, calls its `event`
 * hook and acts through `input.client`, its SDK client. Each plugin instance of the process shares one bridge.
 */
export function pluginSource(command: string[]): string {
  return `// Tonton Claude: shows this machine's OpenCode sessions in the notch, and answers them from it. Written by
// \`tonton install\`, removed by \`tonton uninstall\`. Everything it sees is encrypted by the Tonton agent before it
// leaves the machine.
import { spawn } from 'node:child_process'

const COMMAND = ${JSON.stringify(command)}
const FORWARDED = new Set(${JSON.stringify(FORWARDED_EVENTS)})
const POOL_TOOLS = ${JSON.stringify(ALL_POOL_TOOLS)}
const TOOL_TIMEOUT_MS = 30000
const state = (globalThis.__tontonClaude ??= { bridge: null, inputs: new Map(), client: null, calls: new Map(), nextCall: 0 })
state.calls ??= new Map()
state.nextCall ??= 0
state.nextCall ??= 0

function bridge() {
  if (state.bridge && state.bridge.exitCode === null && !state.bridge.killed) return state.bridge
  const child = spawn(COMMAND[0], COMMAND.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  child.on('error', () => {})
  child.stdin.on('error', () => {})
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline = buffer.indexOf('\\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) run(line)
      newline = buffer.indexOf('\\n')
    }
  })
  state.bridge = child
  return child
}

function send(event) {
  try {
    bridge().stdin.write(JSON.stringify(event) + '\\n')
  } catch {}
}

function forward(event) {
  if (event && FORWARDED.has(event.type)) send(event)
}

/** OpenCode 1's client answers with \`{ data, error }\` instead of throwing. */
function data(result) {
  if (result && result.error) throw new Error(result.error.data?.message ?? result.error.message ?? JSON.stringify(result.error))
  return result && 'data' in result ? result.data : result
}

async function run(line) {
  let command
  try {
    command = JSON.parse(line)
  } catch {
    return
  }
  if (command.op === 'tool_result') {
    const call = state.calls.get(command.callID)
    if (call) {
      state.calls.delete(command.callID)
      call(String(command.output ?? ''))
    }
    return
  }
  try {
    const input = state.inputs.get(command.directory) ?? [...state.inputs.values()].at(-1)
    if (input) await runIn2(input, command)
    else if (state.client) await runIn1(state.client, command)
  } catch (error) {
    send({ type: 'tonton.failed', data: { sessionID: command.sessionID, op: command.op, message: String(error?.message ?? error) } })
  }
}

async function runIn2(input, { op, sessionID, ...command }) {
  if (op === 'prompt') return input.session.prompt({ sessionID, text: command.text })
  if (op === 'reply') return input.permission.reply({ sessionID, requestID: command.requestID, decision: command.decision })
  if (op === 'compact') return input.session.compact({ sessionID })
  if (op === 'interrupt') return input.session.interrupt({ sessionID })
  if (op === 'model') return input.session.switchModel({ sessionID, model: { id: command.modelID, providerID: command.providerID } })
  if (op === 'history') {
    const [info, messages] = await Promise.all([input.session.get({ sessionID }), input.session.context({ sessionID })])
    return send({ type: 'tonton.history', data: { sessionID, info, messages } })
  }
  if (op === 'models') {
    const list = await input.model.list({})
    const models = (list?.data ?? list ?? []).map(model => ({
      providerID: model.providerID,
      modelID: model.modelID ?? model.id,
      context: model.limit?.context,
      released: model.time?.released,
    }))
    return send({ type: 'tonton.models', data: { models } })
  }
}

async function runIn1(client, { op, sessionID, ...command }) {
  const path = { id: sessionID }
  if (op === 'prompt') {
    const model = command.providerID && command.modelID ? { model: { providerID: command.providerID, modelID: command.modelID } } : {}
    return data(await client.session.prompt({ path, body: { ...model, parts: [{ type: 'text', text: command.text }] } }))
  }
  // OpenCode 1 takes the model with the next message, which the bridge adds.
  if (op === 'model') return
  if (op === 'reply') {
    const response = command.decision === 'once' ? 'once' : 'reject'
    return data(await client.postSessionIdPermissionsPermissionId({ path: { id: sessionID, permissionID: command.requestID }, body: { response } }))
  }
  if (op === 'compact') {
    if (!command.providerID || !command.modelID) throw new Error('the session has not answered yet')
    return data(await client.session.summarize({ path, body: { providerID: command.providerID, modelID: command.modelID } }))
  }
  if (op === 'interrupt') return data(await client.session.abort({ path }))
  if (op === 'history') {
    const [info, messages] = await Promise.all([client.session.get({ path }).then(data), client.session.messages({ path }).then(data)])
    return send({ type: 'tonton.history', data: { sessionID, info, messages } })
  }
  if (op === 'models') {
    const providers = data(await client.config.providers())?.providers ?? []
    const models = providers.flatMap(provider =>
      Object.entries(provider.models ?? {}).map(([id, model]) => ({
        providerID: provider.id,
        modelID: id,
        context: model?.limit?.context,
        released: model?.release_date ? Date.parse(model.release_date) : undefined,
      })),
    )
    return send({ type: 'tonton.models', data: { models } })
  }
}

/** A pool tool call, answered by the bridge. */
function callTool(sessionID, name, args) {
  const callID = 'call-' + ++state.nextCall + '-' + Date.now()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      state.calls.delete(callID)
      resolve('Tonton did not answer: the pool tools are not available right now.')
    }, TOOL_TIMEOUT_MS)
    state.calls.set(callID, output => {
      clearTimeout(timer)
      resolve(output)
    })
    send({ type: 'tonton.tool', data: { callID, sessionID, name, args: args ?? {} } })
  })
}

/** OpenCode 2: tools with Effect schemas, added to its registry. */
async function addTools2(input) {
  if (!input.tool?.transform) return
  let Schema
  try {
    ;({ Schema } = await import('effect'))
  } catch {
    return
  }
  const type = param =>
    param.type === 'number' ? Schema.Number : param.type === 'boolean' ? Schema.Boolean : param.type === 'array' ? Schema.Array(Schema.String) : Schema.String
  input.tool.transform(registry => {
    for (const spec of POOL_TOOLS) {
      try {
        if (registry.get?.(spec.name)) continue
        const fields = Object.fromEntries(
          Object.entries(spec.params).map(([name, param]) => [name, param.required ? type(param) : Schema.optional(type(param))]),
        )
        registry.add({
          name: spec.name,
          description: spec.description,
          input: Schema.Struct(fields),
          output: Schema.String,
          options: { namespace: 'tonton' },
          execute: async (args, context) => {
            const text = await callTool(context?.sessionID, spec.name, args)
            return { output: text, content: text }
          },
        })
      } catch {}
    }
  })
}

/** OpenCode 1: the \`tool\` hook, with zod from @opencode-ai/plugin. */
async function tools1() {
  let tool
  try {
    ;({ tool } = await import('@opencode-ai/plugin'))
  } catch {
    return undefined
  }
  const z = tool.schema
  const type = param =>
    (param.type === 'number' ? z.number() : param.type === 'boolean' ? z.boolean() : param.type === 'array' ? z.array(z.string()) : z.string()).describe(
      param.description,
    )
  return Object.fromEntries(
    POOL_TOOLS.map(spec => [
      spec.name,
      tool({
        description: spec.description,
        args: Object.fromEntries(Object.entries(spec.params).map(([name, param]) => [name, param.required ? type(param) : type(param).optional()])),
        execute: async (args, context) => callTool(context?.sessionID, spec.name, args),
      }),
    ]),
  )
}

export default {
  id: 'tonton-claude',
  setup: async input => {
    const directory = input.location?.directory
    if (directory) state.inputs.set(directory, input)
    try {
      await addTools2(input)
    } catch {}
    const controller = new AbortController()
    ;(async () => {
      try {
        for await (const event of input.event.subscribe({ signal: controller.signal })) forward(event)
      } catch {}
    })()
    bridge()
    return () => {
      controller.abort()
      if (state.inputs.get(directory) === input) state.inputs.delete(directory)
    }
  },
  server: async input => {
    if (input?.client) state.client = input.client
    bridge()
    const tool = await tools1().catch(() => undefined)
    return { event: async ({ event }) => forward(event), ...(tool ? { tool } : {}) }
  },
}
`
}
