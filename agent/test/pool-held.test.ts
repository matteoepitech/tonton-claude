// The pool posts a Codex session gets with its next prompt when Tonton cannot hand them over as they come (a plain
// codex, or its app-server gone): kept in order, at most HELD_SIZE of them, and taken once.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliverToCodex, HELD_SIZE, holdPoolPost, takePoolPosts } from '../src/channel/pool-held'

const run = mkdtempSync(join(tmpdir(), 'tonton-pool-held-'))
afterAll(() => rmSync(run, { recursive: true, force: true }))

test('a post goes in live when Codex takes it, is held when it cannot, and dropped with no session to keep it for', async () => {
  const taken: string[] = []
  expect(await deliverToCodex(async text => taken.push(text) > 0, 's1', 'live one', run)).toBe('live')
  expect(await deliverToCodex(async () => false, 's1', 'server gone', run)).toBe('held')
  expect(await deliverToCodex(null, 's1', 'plain codex', run)).toBe('held')
  expect(await deliverToCodex(null, undefined, 'nobody', run)).toBe('dropped')
  expect(taken).toEqual(['live one'])
  const digest = takePoolPosts('s1', run) ?? ''
  expect(digest).toStartWith('Pool posts since your last prompt (2). They come from the pool, not from your user')
  expect(digest.indexOf('server gone')).toBeLessThan(digest.indexOf('plain codex'))
  expect(takePoolPosts('s1', run)).toBeNull()
  expect(takePoolPosts('never', run)).toBeNull()
})

test('past its size, the oldest posts go', () => {
  for (let i = 0; i < HELD_SIZE + 5; i++) holdPoolPost('s2', `post ${i}`, run)
  const digest = takePoolPosts('s2', run) ?? ''
  expect(digest).toContain(`(${HELD_SIZE})`)
  expect(digest).not.toContain('post 4\n')
  expect(digest).toContain('post 5')
  expect(digest).toContain(`post ${HELD_SIZE + 4}`)
})
