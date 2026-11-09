// The client core against what the Mac app's Swift implementation sealed, encoded and read (app/Tests/TontonCoreTests/
// VectorTests.swift wrote the file and checks it on its side). Both must open the same blobs and see the same sessions.
import { describe, expect, test } from 'bun:test'
import { parseAccountToken } from '../account-token'
import { chatItems } from '../chat'
import {
  ClusterVault,
  decodeClusterClaims,
  decodeClusterPostBody,
  decodeClusterSessionProfile,
  openClusterGrant,
  openClusterSessionOrder,
} from '../cluster'
import { parseClusterInvite } from '../cluster-link'
import { open } from '../crypto'
import { modelFamily, modelName } from '../model'
import { openPoolGrant, openPoolSessionOrder } from '../pool'
import { parsePoolInvite } from '../pool-link'
import { openPoolMachineOrder } from '../pool-machines'
import type { StartOrder } from '../protocol'
import { parseRPGState } from '../rpg'
import { parseRPGPool } from '../rpg-pool'
import { acceptsCommands, displayStatusText, type Session } from '../session'
import { parseShareLink } from '../share-link'
import { Vault } from '../vault'
import { parseRelayMessage } from '../wire'
import { checkPoolKeyVectors } from './pool-key-vectors'
import vectors from './swift-vectors.json'

/** Swift leaves out the optionals that are nil, TypeScript has null for them. */
const withoutNulls = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_, field) => (field === null ? undefined : field)))

const projection = (s: Session) => ({
  ...s,
  commands: [...s.commands].sort(),
  modelName: s.model && modelName(s.model),
  modelFamily: s.model && modelFamily(s.model),
  displayStatusText: displayStatusText(s),
  acceptsCommands: acceptsCommands(s),
})

async function read() {
  const vault = new Vault(vectors.key)
  const snapshot = parseRelayMessage(vectors.snapshot)
  const history = parseRelayMessage(vectors.history)
  if (snapshot?.t !== 'snapshot' || history?.t !== 'history') throw new Error('the vectors hold a snapshot and a history')
  const machines = await vault.machines(snapshot.machines)
  const sessions = await Promise.all(snapshot.sessions.map(s => vault.session(s, machines)))
  const entries = await vault.entries(history.entries)
  return { vault, machines, sessions, entries }
}

describe('vectors from the Swift implementation', () => {
  test('Swift pool contributions decode without exposing private inventory', async () => {
    const blob = vectors.blobs.find(b => b.name === 'rpgPool')
    expect(blob).toBeDefined()
    const ledger = parseRPGPool(await open(vectors.key, blob?.blob ?? ''))
    expect(ledger.completions.task.reviewer?.account).toBe('bob')
    expect(ledger.profiles.alice.level).toBe(3)
    expect(ledger.goals['team-v1-demo-3'].eligible).toEqual(['alice', 'bob'])
  })
  test('the Swift hero opens as a validated TypeScript character', async () => {
    const blob = vectors.blobs.find(b => b.name === 'rpg')
    expect(blob).toBeDefined()
    const hero = parseRPGState(await open(vectors.key, blob?.blob ?? ''))
    expect(hero.xp).toBe(50)
    expect(hero.receipts).toHaveLength(1)
  })
  test('every blob the app seals opens to the JSON it sealed', async () => {
    expect(vectors.blobs.length).toBeGreaterThan(5)
    for (const blob of vectors.blobs) expect(await open(vectors.key, blob.blob)).toEqual(JSON.parse(blob.plaintext))
  })

  test('the account token the app shows is read as the app wrote it', () => {
    const { token, ...fields } = vectors.accountToken
    expect(parseAccountToken(token)).toEqual(fields)
  })

  test('the share key the app copies is read as the app wrote it', () => {
    const { text, ...fields } = vectors.shareLink
    expect(parseShareLink(text)).toEqual(fields)
    // From the address bar too: the web app takes it after the #.
    expect(parseShareLink(`#${text}`)).toEqual(fields)
  })

  test('a pool key the app wrapped after a kick opens here, and with it what the app sealed with that version', async () => {
    await checkPoolKeyVectors({ ...vectors.poolKeys, key: vectors.key })
  })

  test("the pool invite the app makes, its key grant and a session's order, are read as the app wrote them", async () => {
    const { text, ...fields } = vectors.poolInvite
    expect(parsePoolInvite(text)).toEqual(fields)
    const blob = (name: string) => vectors.blobs.find(b => b.name === name)?.blob ?? ''
    expect(await openPoolGrant(vectors.key, blob('pool key grant'), 'pool00000001')).toEqual({
      poolId: 'pool00000001',
      key: 'k'.repeat(43),
      version: 1,
    })
    // As the agent checks it: for this session and this pool only.
    expect(await openPoolSessionOrder(vectors.key, blob('pool session order'), 's1', 'pool00000001')).toMatchObject({ version: 1 })
    expect(await openPoolSessionOrder(vectors.key, blob('pool session order'), 's2', 'pool00000001')).toBeNull()
  })

  test('the cluster invite, key grant, session order, post, session profile and claims the app makes are read as the app wrote them', async () => {
    const { text, pool, ...fields } = vectors.clusterInvite
    expect(parseClusterInvite(text)).toEqual({ ...fields, cluster: pool })
    const blob = (name: string) => vectors.blobs.find(b => b.name === name)?.blob ?? ''
    expect(await openClusterGrant(vectors.key, blob('cluster key grant'), 'clus00000001')).toEqual({
      clusterId: 'clus00000001',
      key: 'k'.repeat(43),
      version: 1,
    })
    // As the agent checks it: for this session and this cluster only, with the delivery its owner chose.
    expect(await openClusterSessionOrder(vectors.key, blob('cluster session order'), 's1', 'clus00000001')).toMatchObject({
      key: 'k'.repeat(43),
      version: 1,
      delivery: 'digest',
      liveWithoutPrompts: true,
    })
    expect(await openClusterSessionOrder(vectors.key, blob('cluster session order'), 's2', 'clus00000001')).toBeNull()
    // The vectors' key stands for version 1 of a cluster key.
    const cluster = new ClusterVault(vectors.key)
    expect(await cluster.read(blob('cluster post'), decodeClusterPostBody)).toEqual({
      kind: 'event',
      text: 'Submitted the hero rig ✅',
      to: [{ account: 'bob000000001', session: 's1' }],
      topic: 'art',
      event: { type: 'submit', ok: true, ref: '1234', paths: ['Content/Characters/Hero/SK_Hero.uasset'], count: 3 },
    })
    // A session set to live that skips permission prompts, as its agent says it: it gets digests.
    expect(await cluster.read(blob('cluster session profile'), decodeClusterSessionProfile)).toEqual({
      name: 'rig ✨',
      project: 'jam',
      machine: 'Studio',
      tool: 'claude',
      model: 'claude-opus-5-5',
      branch: 'main',
      status: 'rigging the hero',
      statusAt: '2026-11-04T10:00:00Z',
      delivery: 'digest',
      skipsPrompts: true,
    })
    expect(await cluster.read(blob('cluster claims'), decodeClusterClaims)).toEqual({
      claims: [
        {
          id: 'claim0000001',
          paths: ['Content/Maps/Main.umap'],
          reason: 'lighting pass',
          account: 'bob000000001',
          session: 's1',
          at: '2026-11-04T10:00:00Z',
          until: '2026-11-04T12:00:00Z',
        },
      ],
    })
  })

  test("the order that puts one of the account's machines in a pool is read as the app wrote it, by that machine only", async () => {
    const blob = vectors.blobs.find(b => b.name === 'pool machine order')?.blob ?? ''
    expect(await openPoolMachineOrder(vectors.key, blob, 'machine00001', 'pool00000001')).toMatchObject({
      key: 'k'.repeat(43),
      version: 1,
      profile: { name: 'Studio ✨', tool: 'opencode', capacity: 3, workdir: '~/pool', mode: 'edits', takes: 'simple', areas: ['back'] },
    })
    expect(await openPoolMachineOrder(vectors.key, blob, 'machine00002', 'pool00000001')).toBeNull()
  })

  test('machines and sessions read the same as in the app', async () => {
    const { machines, sessions } = await read()
    expect(withoutNulls(machines)).toEqual(vectors.expected.machines)
    expect(withoutNulls(sessions.map(projection))).toEqual(vectors.expected.sessions)
  })

  test('a Codex session and a Codex start name their tool as the agent reads it', async () => {
    const { sessions } = await read()
    expect(sessions.find(s => s.id === 's1')?.tool).toBe('codex')
    const order = await open<StartOrder>(vectors.key, vectors.blobs.find(b => b.name === 'codex start order')?.blob ?? '')
    expect(order.tool).toBe('codex')
    const claude = await open<StartOrder>(vectors.key, vectors.blobs.find(b => b.name === 'start order')?.blob ?? '')
    expect(claude.tool).toBeUndefined()
  })

  test('the conversation reads the same, and merges tool calls with their results the same way', async () => {
    const { entries } = await read()
    expect(withoutNulls(entries)).toEqual(vectors.expected.entries)
    const chat = chatItems(entries).map(item => ({
      kind: item.kind,
      id: item.id,
      result: item.kind === 'tool' ? item.result?.id : undefined,
    }))
    expect(withoutNulls(chat)).toEqual(vectors.expected.chat)
  })

  test('what the client seals is what the app seals', async () => {
    const vault = new Vault(vectors.key)
    const fromApp = (name: string) => JSON.parse(vectors.blobs.find(blob => blob.name === name)?.plaintext ?? 'null')
    const prompt = await open(
      vectors.key,
      await vault.sealPrompt('Run the tests', [{ name: 'a.png', mediaType: 'image/png', data: 'iVBORw0K' }]),
    )
    expect(prompt).toEqual(fromApp('prompt'))

    const command = await open<{ command: Record<string, string> }>(
      vectors.key,
      await vault.sealCommand('compact', 's1', { issuedAt: new Date(1_792_497_600_000) }),
    )
    const appCommand = fromApp('command').command
    expect(Object.keys(command.command).sort()).toEqual(Object.keys(appCommand).sort())
    expect({ ...command.command, id: '' }).toEqual({ ...appCommand, id: '', issuedAt: command.command.issuedAt })
    expect(Date.parse(command.command.issuedAt)).toBe(Date.parse(appCommand.issuedAt))

    const model = await open<{ command: Record<string, string> }>(vectors.key, await vault.sealCommand('model', 's1', { model: 'haiku' }))
    const appModel = fromApp('model command').command
    expect(Object.keys(model.command).sort()).toEqual(Object.keys(appModel).sort())
    expect([model.command.name, model.command.model]).toEqual([appModel.name, appModel.model])
    // Only the model command carries a model, as in the app.
    const compact = await open<{ command: object }>(vectors.key, await vault.sealCommand('compact', 's1', { model: 'haiku' }))
    expect(compact.command).not.toHaveProperty('model')
  })
})
