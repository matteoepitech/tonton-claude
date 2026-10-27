// The island's page as electron-builder packages it: one HTML file, like the web app, that runs only what it carries,
// and that never sees the relay token.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPage } from '../../scripts/build-web'

const desktop = join(import.meta.dir, '..')
const dir = mkdtempSync(join(tmpdir(), 'tonton-island-page-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('the page stands alone, holds no token, and nothing a session says can become HTML in it', async () => {
  const file = join(dir, 'island.html')
  await buildPage(
    join(desktop, 'src/renderer/island.ts'),
    [join(desktop, '../web/style.css'), join(desktop, 'src/renderer/island.css')],
    file,
  )
  const page = readFileSync(file, 'utf8')
  expect(page).toContain('tonton/v1')
  expect(page).toContain("default-src 'none'")
  expect(page).not.toMatch(/<script[^>]+src=/)
  // The socket goes out bare: the main process adds the token (src/main/relay-auth.ts).
  expect(page).not.toContain('bearer.')
  const code = readFileSync(join(desktop, 'src/renderer/island.ts'), 'utf8')
  expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/)
})
