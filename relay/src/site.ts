// The website at the relay's address: the web app (web/), so a browser needs nothing but the relay's address. In the
// relay's executable, Bun has bundled web/site.html with its script and style; from the sources (`bun run relay`, the
// tests) they are built at the first visit. Every file goes out with a strict Content-Security-Policy: the page runs its
// own script and style and nothing else, and opens sockets to this relay only.
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import page from '../../web/site.html'

interface SiteFile {
  bytes: Uint8Array<ArrayBuffer>
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
  const headers = {
    'content-type': file.type,
    'cache-control': file.isPage ? 'no-cache' : 'public, max-age=31536000, immutable',
    'content-security-policy': policy(new URL(req.url).host),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  }
  return new Response(req.method === 'HEAD' ? null : file.bytes, { headers })
}

export function policy(host: string): string {
  // Older browsers don't count a socket to the same address as 'self'.
  const sockets = /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) ? ` wss://${host} ws://${host}` : ''
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
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
    site.set(isPage ? '/' : `/${basename(name)}`, { bytes: new Uint8Array(await blob.arrayBuffer()), type, isPage })
  }
  return site
}

async function build() {
  const built = await Bun.build({ entrypoints: [fileURLToPath(new URL('../../web/site.html', import.meta.url))], minify: true })
  if (!built.success) throw new Error(built.logs.map(String).join('\n'))
  return built.outputs.map(output => ({ name: output.path, type: output.type, blob: output }))
}
