// The pool tools in Tonton's OpenCode plugin, with stand-ins for what OpenCode gives a plugin: OpenCode 2's tool registry
// with Effect schemas, OpenCode 1's `tool` hook with zod from @opencode-ai/plugin, and a bridge that answers each call.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POOL_TOOLS } from '../src/channel/pool-work'
import { pluginSource } from '../src/opencode/plugin'

const dir = mkdtempSync(join(tmpdir(), 'tonton-plugin-tools-'))
afterAll(() => {
  ;(globalThis as { __tontonClaude?: { bridge?: { kill(): void } } }).__tontonClaude?.bridge?.kill()
  rmSync(dir, { recursive: true, force: true })
})

/** A package next to the plugin, as OpenCode installs them in its config folder. */
function fakePackage(name: string, source: string) {
  const folder = join(dir, 'node_modules', name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }))
  writeFileSync(join(folder, 'index.js'), source)
}

fakePackage(
  'effect',
  `export const Schema = {
  String: { kind: 'string' }, Number: { kind: 'number' }, Boolean: { kind: 'boolean' },
  Array: item => ({ kind: 'array', item }), optional: schema => ({ optional: schema }), Struct: fields => ({ struct: fields }),
}\n`,
)
fakePackage(
  '@opencode-ai/plugin',
  `const make = kind => ({ kind, describe(d) { return { ...this, description: d } }, optional() { return { ...this, optional: true } } })
export function tool(input) { return input }
tool.schema = { string: () => make('string'), number: () => make('number'), boolean: () => make('boolean'), array: () => make('array') }\n`,
)
// Answers every call with what it got.
const bridge = join(dir, 'bridge.ts')
writeFileSync(
  bridge,
  `let buffer = ''
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const event = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    if (event.type !== 'tonton.tool') continue
    const { callID, sessionID, name, args } = event.data
    process.stdout.write(JSON.stringify({ op: 'tool_result', callID, output: ['ok', name, sessionID, JSON.stringify(args)].join(' ') }) + '\\n')
  }
}\n`,
)

test('OpenCode 1 and 2 get the pool tools, and each call goes to the bridge and back', async () => {
  ;(globalThis as { __tontonClaude?: unknown }).__tontonClaude = undefined
  const file = join(dir, 'tonton-claude.js')
  writeFileSync(file, pluginSource([process.execPath, bridge]))
  const plugin = (await import(file)).default

  // OpenCode 2: its registry, through input.tool.transform.
  const added: { name: string; input: { struct: Record<string, unknown> }; execute(args: object, context: object): Promise<unknown> }[] = []
  const registry = { get: () => undefined, add: (tool: (typeof added)[number]) => added.push(tool) }
  async function* none() {}
  await plugin.setup({
    event: { subscribe: () => none() },
    tool: { transform: (change: (r: typeof registry) => void) => change(registry) },
  })
  expect(added.map(tool => tool.name)).toEqual(POOL_TOOLS.map(tool => tool.name))
  const send = added.find(tool => tool.name === 'pool_send')
  expect(send?.input.struct.text).toEqual({ kind: 'string' })
  expect(send?.input.struct.to_area).toEqual({ optional: { kind: 'string' } })
  expect(await send?.execute({ text: 'hi' }, { sessionID: 'ses_2' })).toEqual({
    output: 'ok pool_send ses_2 {"text":"hi"}',
    content: 'ok pool_send ses_2 {"text":"hi"}',
  })

  // OpenCode 1: the tool hook.
  const hooks = await plugin.server({})
  expect(Object.keys(hooks.tool)).toEqual(POOL_TOOLS.map(tool => tool.name))
  expect(hooks.tool.task_done.args.summary).toMatchObject({ kind: 'string', description: 'What was done.' })
  expect(hooks.tool.task_done.args.branch).toMatchObject({ optional: true })
  expect(await hooks.tool.task_done.execute({ task: 't1', summary: 'done' }, { sessionID: 'ses_1' })).toBe(
    'ok task_done ses_1 {"task":"t1","summary":"done"}',
  )
})
