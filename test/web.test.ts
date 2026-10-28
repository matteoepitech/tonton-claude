// The web app as the release ships it: one HTML file, its script and style inline, that runs only what it carries.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
  // React in its production build: the development one is many times bigger and warns in the console.
  expect(page).toContain('Minified React error')
  expect(page).toContain('--color-primary')
  // Text from Claude, tools and the relay goes in as text only. A pool's tasks, names and invites too: other members
  // wrote them. React escapes what it renders; nothing here may hand it HTML.
  const sources = ['web/views.ts', 'web/markdown.ts', 'web/scanner.ts', ...sourcesIn('web/site')]
  expect(sources.length).toBeGreaterThan(20)
  for (const source of sources) {
    const code = readFileSync(join(import.meta.dir, '..', source), 'utf8')
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write|eval\(|new Function/)
  }
})

/** The website's sources, every folder down. */
function sourcesIn(folder: string): string[] {
  const root = join(import.meta.dir, '..')
  return readdirSync(join(root, folder), { recursive: true, encoding: 'utf8' })
    .filter(name => /\.tsx?$/.test(name))
    .map(name => join(folder, name))
}
