// The web app as the release ships it: one HTML file, its script and style inline, that runs only what it carries.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWeb } from '../scripts/build-web'

const dir = mkdtempSync(join(tmpdir(), 'tonton-web-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('the page stands alone, and nothing a session says can become HTML in it', async () => {
  const file = join(dir, 'tonton-web.html')
  await buildWeb(file)
  const page = readFileSync(file, 'utf8')
  expect(page).not.toContain('/* SCRIPT */')
  expect(page).not.toContain('/* STYLE */')
  expect(page).toContain('tonton/v1')
  // No other script, style or connection than its own and the relay's socket.
  expect(page).toContain("default-src 'none'")
  expect(page).not.toMatch(/<script[^>]+src=/)
  expect(page).not.toMatch(/<link[^>]+stylesheet/)
  // Text from Claude, tools and the relay goes in as text only.
  // A pool's tasks, names and invites too: other members wrote them.
  for (const source of [
    'web/app.ts',
    'web/views.ts',
    'web/markdown.ts',
    'web/scanner.ts',
    'web/pools.ts',
    'web/tasks.ts',
    'web/control.ts',
    'web/activity.ts',
    'web/leaderboard.ts',
  ]) {
    const code = readFileSync(join(import.meta.dir, '..', source), 'utf8')
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/)
  }
})
