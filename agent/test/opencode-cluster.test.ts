// Cluster posts in Tonton's OpenCode plugin: a synthetic part, never the user's text. OpenCode 2 takes it through
// `session.synthetic`, OpenCode 1 as a synthetic text part of a prompt, without a reply when it must not wake the session.
// And cluster_ask gets the time to wait for its answer.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLUSTER_TOOLS } from '../src/channel/cluster-work'
import { pluginSource } from '../src/opencode/plugin'

const dir = mkdtempSync(join(tmpdir(), 'tonton-plugin-cluster-'))
type Global = { __tontonClaude?: { bridge?: { kill(): void } } }
afterAll(() => {
  ;(globalThis as Global).__tontonClaude?.bridge?.kill()
  rmSync(dir, { recursive: true, force: true })
})

// Writes what the bridge would for two cluster posts: one that wakes the session, one for its next turn.
const bridge = join(dir, 'bridge.ts')
writeFileSync(
  bridge,
  `const post = wake => JSON.stringify({ op: 'inject', sessionID: 'ses_1', directory: '/d', text: '<cluster kind="ask">' + wake + '</cluster>', wake })
process.stdout.write(post(true) + '\\n' + post(false) + '\\n')
for await (const _ of Bun.stdin.stream());\n`,
)

async function eventually(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await Bun.sleep(30)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function load(name: string) {
  ;(globalThis as Global).__tontonClaude?.bridge?.kill()
  ;(globalThis as Global).__tontonClaude = undefined
  const file = join(dir, name)
  writeFileSync(file, pluginSource([process.execPath, bridge]))
  return (await import(file)).default
}

test('OpenCode 2: a synthetic message, resumed only when it wakes the session', async () => {
  const plugin = await load('tonton-claude-2.js')
  const synthetic: Record<string, unknown>[] = []
  const prompts: unknown[] = []
  async function* none() {}
  await plugin.setup({
    location: { directory: '/d' },
    event: { subscribe: () => none() },
    session: { synthetic: (input: Record<string, unknown>) => synthetic.push(input), prompt: (input: unknown) => prompts.push(input) },
  })
  await eventually(() => synthetic.length === 2, 'two synthetic messages')
  expect(synthetic).toEqual([
    {
      sessionID: 'ses_1',
      text: '<cluster kind="ask">true</cluster>',
      description: 'A post from a Tonton cluster',
      metadata: { tonton: 'cluster' },
      delivery: 'queue',
      resume: true,
    },
    {
      sessionID: 'ses_1',
      text: '<cluster kind="ask">false</cluster>',
      description: 'A post from a Tonton cluster',
      metadata: { tonton: 'cluster' },
      delivery: 'steer',
      resume: false,
    },
  ])
  expect(prompts).toEqual([])
})

test('OpenCode 1: a synthetic part, with no reply when it must not wake the session', async () => {
  const plugin = await load('tonton-claude-1.js')
  const prompts: { path: unknown; body: Record<string, unknown> }[] = []
  await plugin.server({ client: { session: { prompt: (input: (typeof prompts)[number]) => prompts.push(input) && { data: {} } } } })
  await eventually(() => prompts.length === 2, 'two prompts')
  const part = (text: string) => ({ type: 'text', text, synthetic: true, metadata: { tonton: 'cluster' } })
  expect(prompts).toEqual([
    { path: { id: 'ses_1' }, body: { parts: [part('<cluster kind="ask">true</cluster>')] } },
    { path: { id: 'ses_1' }, body: { noReply: true, parts: [part('<cluster kind="ask">false</cluster>')] } },
  ])
})

test('cluster_ask may wait for its answer longer than the other tools', () => {
  const ask = CLUSTER_TOOLS.find(tool => tool.name === 'cluster_ask')
  expect(ask?.waitMs).toBeGreaterThan(10 * 60_000)
  expect(pluginSource(['tonton'])).toContain('"waitMs":630000')
})
