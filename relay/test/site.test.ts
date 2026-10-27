// The website at the relay's address: the web app, its files only, under a policy that runs nothing else.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { startRelay } from '../src/main'
import { policy } from '../src/site'

const dir = mkdtempSync(join(tmpdir(), 'tonton-site-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir }))
const base = `http://127.0.0.1:${relay.server.port}`

afterAll(() => {
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('the relay serves the web app, its script and style from its own address', async () => {
  const page = await fetch(`${base}/`)
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toContain('text/html')
  expect(page.headers.get('cache-control')).toBe('no-cache')
  const html = await page.text()
  // Nothing inline: the policy would refuse it.
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
  expect(html).not.toContain('<style')
  const assets = [...html.matchAll(/(?:src|href)="\.?(\/[^"]+)"/g)].map(match => match[1])
  expect(assets.length).toBe(2)
  for (const asset of assets) {
    const file = await fetch(`${base}${asset}`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toMatch(asset.endsWith('.js') ? /javascript/ : /text\/css/)
    expect(file.headers.get('cache-control')).toContain('immutable')
    expect(file.headers.get('content-security-policy')).toBe(policy(`127.0.0.1:${relay.server.port}`))
    if (asset.endsWith('.js')) expect(await file.text()).toContain('tonton/v1')
  }
  expect((await fetch(`${base}/index.html`)).status).toBe(200)
})

test('every file comes with a policy that allows its own script, style and sockets only', async () => {
  const page = await fetch(`${base}/`)
  const csp = page.headers.get('content-security-policy') ?? ''
  const host = `127.0.0.1:${relay.server.port}`
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("script-src 'self';")
  expect(csp).toContain("style-src 'self';")
  expect(csp).toContain(`connect-src 'self' wss://${host} ws://${host};`)
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).not.toContain('unsafe')
  expect(page.headers.get('x-frame-options')).toBe('DENY')
  expect(page.headers.get('x-content-type-options')).toBe('nosniff')
  expect(page.headers.get('referrer-policy')).toBe('no-referrer')
  // A Host header that is not an address adds no source.
  expect(policy("evil.example; script-src 'unsafe-inline'")).toContain("connect-src 'self';")
})

test('other paths and methods are not the website', async () => {
  expect((await fetch(`${base}/nothing.js`)).status).toBe(404)
  expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(404)
  const head = await fetch(`${base}/`, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  expect((await fetch(`${base}/health`)).status).toBe(200)
})
