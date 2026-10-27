// The client core against what the Mac app's Swift implementation sealed, encoded and read (app/Tests/TontonCoreTests/
// VectorTests.swift wrote the file and checks it on its side). Both must open the same blobs and see the same sessions.
import { describe, expect, test } from 'bun:test'
import { parseAccountToken } from '../account-token'
import { chatItems } from '../chat'
import { open } from '../crypto'
import { modelFamily, modelName } from '../model'
import { openPoolGrant, openPoolSessionOrder } from '../pool'
import { parsePoolInvite } from '../pool-link'
import { acceptsCommands, displayStatusText, type Session } from '../session'
import { parseShareLink } from '../share-link'
import { Vault } from '../vault'
import { parseRelayMessage } from '../wire'
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

  test('machines and sessions read the same as in the app', async () => {
    const { machines, sessions } = await read()
    expect(withoutNulls(machines)).toEqual(vectors.expected.machines)
    expect(withoutNulls(sessions.map(projection))).toEqual(vectors.expected.sessions)
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
