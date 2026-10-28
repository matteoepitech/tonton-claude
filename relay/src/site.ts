// The website at the relay's address: the web app (web/), so a browser needs nothing but the relay's address. In the
// relay's executable, Bun has bundled web/site.html with its script and style (scripts/build.ts); from the sources
// (`bun run relay`, the tests) they are built at the first visit. Every file goes out with a strict
// Content-Security-Policy: the page runs its own script and style and nothing else, and opens sockets to this relay only.
// The page also gets a nonce of its own at each visit, for the few <style> tags its components add while it runs (Radix
// locking the page's scroll under a dialog); no script can use it.

import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BunPlugin } from 'bun'
import page from '../../web/site.html'

interface SiteFile {
  bytes: Uint8Array<ArrayBuffer>
  /** The script and the style, compressed once: React and its components weigh most of a megabyte. */
  gzip?: Uint8Array<ArrayBuffer>
  type: string
  /** The page itself: asked for again at each visit. The others have a hash in their name and never change. */
  isPage: boolean
}

let files: Promise<Map<string, SiteFile>> | null = null

/** The response for a file of the website, null when `path` is not one (or the site could not be built). */
export async function siteResponse(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  files ??= load().catch(error => {
    console.error(`relay: the website could not be built: ${error instanceof Error ? error.message : String(error)}`)
    return new Map()
  })
  const file = (await files).get(path === '/index.html' ? '/' : path)
  if (!file) return null
  const nonce = file.isPage ? newNonce() : undefined
  const headers = {
    'content-type': file.type,
    'cache-control': file.isPage ? 'no-cache' : 'public, max-age=31536000, immutable',
    'content-security-policy': policy(new URL(req.url).host, nonce),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  }
  if (nonce) return new Response(req.method === 'HEAD' ? null : withNonce(file.bytes, nonce), { headers })
  const gzip = file.gzip && /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '') ? file.gzip : null
  const compressed: Record<string, string> = gzip ? { 'content-encoding': 'gzip' } : {}
  return new Response(req.method === 'HEAD' ? null : (gzip ?? file.bytes), {
    headers: { ...headers, ...compressed, vary: 'accept-encoding' },
  })
}

/** The page tells its components the nonce in a meta tag, read once at start (web/site/main.tsx). */
function withNonce(page: Uint8Array<ArrayBuffer>, nonce: string): string {
  return new TextDecoder().decode(page).replace('</head>', `<meta name="csp-nonce" content="${nonce}">\n</head>`)
}

const newNonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64')

export function policy(host: string, nonce?: string): string {
  // Older browsers don't count a socket to the same address as 'self'.
  const sockets = /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) ? ` wss://${host} ws://${host}` : ''
  return [
    "default-src 'none'",
    "script-src 'self'",
    nonce ? `style-src 'self' 'nonce-${nonce}'` : "style-src 'self'",
    `connect-src 'self'${sockets}`,
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

async function load(): Promise<Map<string, SiteFile>> {
  // In the executable: the files Bun bundled, listed in the import's manifest.
  const outputs = page.files
    ? page.files.map(file => ({ name: file.path, type: file.headers['content-type'], blob: Bun.file(file.path) }))
    : await build()
  const site = new Map<string, SiteFile>()
  for (const { name, type, blob } of outputs) {
    const isPage = name.endsWith('.html')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    site.set(isPage ? '/' : `/${basename(name)}`, { bytes, gzip: isPage ? undefined : Bun.gzipSync(bytes), type, isPage })
  }
  return site
}

async function build() {
  // From the sources only. The name in a variable keeps the build tools out of the relay's executable.
  const tools = '../../scripts/site-build'
  const { SITE_DEFINE, SITE_PLUGINS } = (await import(tools)) as { SITE_DEFINE: Record<string, string>; SITE_PLUGINS: BunPlugin[] }
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../../web/site.html', import.meta.url))],
    minify: true,
    define: SITE_DEFINE,
    plugins: SITE_PLUGINS,
  })
  if (!built.success) throw new Error(built.logs.map(String).join('\n'))
  return built.outputs.map(output => ({ name: output.path, type: output.type, blob: output }))
}
