// What a Claude Code session sends the relay when it (re)connects: its backlog's images within a budget, the newest kept,
// and the sealed entries in messages the relay takes. The OpenCode bridge sends its backlog the same way.
import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newAccountKey, open } from '../../shared/crypto'
import type { AgentMessage, Entry, SealedEntry } from '../../shared/protocol'
import { Conversation } from '../src/channel/conversation'
import { entriesMessages, MAX_MESSAGE_BYTES } from '../src/channel/relay-connection'
import { BACKLOG_IMAGES, backlogImages, forgetOldImages } from '../src/transcript/images'

const dir = mkdtempSync(join(tmpdir(), 'tonton-conversation-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const MB = 1024 * 1024
const ts = '2026-11-04T10:00:00Z'
const shot = (fill: string, size = 3 * MB) => ({ mediaType: 'image/png', data: fill.repeat(size) })
const result = (id: string, images: ReturnType<typeof shot>[]): Entry => ({
  id,
  ts,
  kind: 'tool_result',
  toolUseId: id,
  text: `shot ${id}`,
  isError: false,
  images,
})
const kept = (entries: Entry[]) => entries.map(entry => ('images' in entry ? (entry.images ?? []).map(image => image.data[0]) : []))
const texts = (entries: Entry[]) => entries.map(entry => ('text' in entry ? entry.text : ''))

async function eventually<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('the backlog', () => {
  test('keeps the images of the newest entries within its budget, the others say how many they had', () => {
    const entries = ['A', 'B', 'C', 'D', 'E', 'F'].map(fill => result(fill, [shot(fill)]))
    const backlog = backlogImages(entries)
    expect(kept(backlog)).toEqual([[], [], [], ['D'], ['E'], ['F']])
    expect(texts(backlog).slice(0, 3)).toEqual([
      'shot A\n[1 image not loaded]',
      'shot B\n[1 image not loaded]',
      'shot C\n[1 image not loaded]',
    ])
    // An entry that fits in part keeps what fits.
    expect(kept(backlogImages([result('G', [shot('G'), shot('H')])], { budget: 4 * MB }))).toEqual([['G']])
    // And past the latest entries, none keeps its images, however small.
    expect(kept(backlogImages([result('I', [shot('I', 8)]), result('J', [shot('J', 8)])], { latest: 1 }))).toEqual([[], ['J']])
    // The conversation itself keeps them, for the next reconnection.
    expect(entries[0]).toMatchObject({ images: [{ data: 'A'.repeat(3 * MB) }] })
  })

  test('lets go of the images no reconnection sends again, and sends the same as with them', () => {
    const entries = Array.from({ length: BACKLOG_IMAGES + 5 }, (_, index) => result(`r${index}`, [shot('x', 8), shot('y', 8)]))
    const kept = forgetOldImages(entries)
    expect(kept.map(entry => 'images' in entry && entry.images?.length)).toEqual([
      ...Array(5).fill(false),
      ...Array(BACKLOG_IMAGES).fill(2),
    ])
    expect(texts(kept)).toEqual(texts(entries))
    expect(backlogImages(kept)).toEqual(backlogImages(entries))
    expect(texts(backlogImages(kept))[0]).toBe('shot r0\n[2 images not loaded]')
    // Again on what it already let go: nothing changes.
    expect(forgetOldImages(kept)).toEqual(kept)
    expect(backlogImages(forgetOldImages(kept))).toEqual(backlogImages(entries))
  })

  test('too big for one message, it goes in several under the limit, only the first a reset', () => {
    const sealed = (id: string, size: number): SealedEntry => ({ id, ts, blob: 'x'.repeat(size) })
    const entries = ['a', 'b', 'c', 'd', 'e'].map(id => sealed(id, 3000))
    const messages = entriesMessages('ses_1', entries, true, 8000)
    expect(messages.map(message => message.t === 'entries' && [message.reset, message.entries.map(entry => entry.id)])).toEqual([
      [true, ['a', 'b']],
      [false, ['c', 'd']],
      [false, ['e']],
    ])
    for (const message of messages) expect(JSON.stringify(message).length).toBeLessThan(8000)
    // Live entries add to the history, and an empty backlog still empties the relay's copy.
    expect(entriesMessages('ses_1', entries, false, 8000).every(message => message.t === 'entries' && !message.reset)).toBe(true)
    expect(entriesMessages('ses_1', [], true)).toEqual([{ t: 'entries', sessionId: 'ses_1', entries: [], reset: true }])
    // One entry that no message could carry is left out: sent, it would close the socket.
    expect(entriesMessages('ses_1', [sealed('big', 9000), sealed('f', 10)], true, 8000)).toMatchObject([{ entries: [{ id: 'f' }] }])
  })
})

describe('a Claude Code session that reconnects', () => {
  test('holds images only on its latest entries, and announces and names its last message as before', async () => {
    const key = newAccountKey()
    const transcript = join(dir, 'screenshots.jsonl')
    const line = (uuid: string, content: unknown) => `${JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { content } })}\n`
    const image = (fill: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fill.repeat(64) } })
    const results = Array.from({ length: BACKLOG_IMAGES + 5 }, (_, index) =>
      line(`r${index}`, [
        { type: 'tool_result', tool_use_id: `t${index}`, content: [{ type: 'text', text: `shot ${index}` }, image('s')] },
      ]),
    )
    writeFileSync(transcript, line('u0', [{ type: 'text', text: 'Look at this' }, image('u')]) + results.join(''))

    const sent: AgentMessage[] = []
    let outbox = Promise.resolve()
    const post = (build: () => Promise<AgentMessage | AgentMessage[] | null>) => {
      outbox = outbox.then(async () => {
        const message = await build()
        if (message) sent.push(...[message].flat())
      })
    }
    const conversation = new Conversation({ sessionId: 'ses_held', transcriptPath: transcript, cwd: dir }, 'Mac', key, true, post)
    conversation.start()
    try {
      await eventually(() => sent.some(message => message.t === 'entries' && message.reset), 'the backlog')
      await outbox
      // What the session holds, read past its privacy: the point is what stays in memory.
      const held = (conversation as unknown as { entries: Entry[] }).entries
      expect(held).toHaveLength(BACKLOG_IMAGES + 6)
      expect(held.map(entry => 'images' in entry && Boolean(entry.images?.length))).toEqual([
        ...Array(6).fill(false),
        ...Array(BACKLOG_IMAGES).fill(true),
      ])

      const opened = async () => {
        const messages = sent.flatMap(message => (message.t === 'entries' && message.reset ? [message] : []))
        const backlog = await Promise.all(messages.flatMap(message => message.entries).map(entry => open<Entry>(key, entry.blob)))
        const meta = sent.findLast(message => message.t === 'meta')
        return { backlog, meta: meta?.t === 'meta' ? await open<{ lastMessage?: string }>(key, meta.meta) : undefined }
      }
      const { backlog, meta } = await opened()
      expect(texts(backlog).slice(0, 2)).toEqual(['Look at this\n[1 image not loaded]', 'shot 0\n[1 image not loaded]'])
      expect(backlog.filter(entry => 'images' in entry && entry.images?.length)).toHaveLength(BACKLOG_IMAGES)
      expect(meta?.lastMessage).toBe('Look at this')

      // A reconnection sends it all the same.
      sent.length = 0
      conversation.announce()
      await outbox
      expect(await opened()).toEqual({ backlog, meta })
    } finally {
      conversation.stop()
    }
  }, 20_000)

  test('sends its backlog in messages the relay takes, its newest images kept within the budget', async () => {
    const key = newAccountKey()
    const transcript = join(dir, 'session.jsonl')
    const line = (uuid: string, content: unknown) => `${JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { content } })}\n`
    writeFileSync(transcript, line('u0', 'ready'))

    const sent: AgentMessage[] = []
    let outbox = Promise.resolve()
    const post = (build: () => Promise<AgentMessage | AgentMessage[] | null>) => {
      outbox = outbox.then(async () => {
        const message = await build()
        if (message) sent.push(...[message].flat())
      })
    }
    const conversation = new Conversation({ sessionId: 'ses_shots', transcriptPath: transcript, cwd: dir }, 'Mac', key, true, post)
    conversation.start()
    try {
      // Six screenshots, then three long pastes: more than the relay takes in one message, even with images left out.
      const image = (fill: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fill.repeat(3 * MB) } })
      for (const fill of ['A', 'B', 'C', 'D', 'E', 'F']) {
        appendFileSync(
          transcript,
          line(fill, [{ type: 'tool_result', tool_use_id: fill, content: [{ type: 'text', text: `shot ${fill}` }, image(fill)] }]),
        )
      }
      for (const fill of ['p', 'q', 'r']) appendFileSync(transcript, line(fill, fill.repeat(4 * MB)))
      await eventually(() => sent.some(message => message.t === 'entries' && message.entries.some(entry => entry.id === 'r')), 'the pastes')
      await outbox

      sent.length = 0
      conversation.announce()
      await outbox
      const messages = sent.flatMap(message => (message.t === 'entries' ? [message] : []))
      expect(messages.length).toBeGreaterThan(1)
      expect(messages.map(message => message.reset)).toEqual([true, ...messages.slice(1).map(() => false)])
      for (const message of messages) expect(JSON.stringify(message).length).toBeLessThan(MAX_MESSAGE_BYTES)

      const backlog = await Promise.all(messages.flatMap(message => message.entries).map(entry => open<Entry>(key, entry.blob)))
      expect(backlog.map(entry => entry.id)).toEqual(['u0', 'A:0', 'B:0', 'C:0', 'D:0', 'E:0', 'F:0', 'p', 'q', 'r'])
      expect(kept(backlog).slice(1, 7)).toEqual([[], [], [], ['D'], ['E'], ['F']])
      expect(texts(backlog)[1]).toBe('shot A\n[1 image not loaded]')
    } finally {
      conversation.stop()
    }
  }, 20_000)
})
