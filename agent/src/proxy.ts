// The proxy the agent goes through to reach the relay, from the variables curl and Bun's fetch read. fetch() follows them
// on its own, but Bun's WebSocket client does not: the relay connection asks here. The rules are the ones fetch applies in
// Bun 1.4, so both kinds of connection take the same way out.

type Env = Record<string, string | undefined>

/** For each scheme, the first one set wins. Lower case comes first, as with curl. */
const PROXY_NAMES = {
  https: ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'],
  http: ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'],
}
const NO_PROXY_NAMES = ['no_proxy', 'NO_PROXY']

/** Everything that decides the proxy, which the background service must get although it does not start from a shell. */
export const PROXY_VARIABLES = [...new Set([...PROXY_NAMES.https, ...PROXY_NAMES.http, ...NO_PROXY_NAMES])]

export interface Proxy {
  url: string
  /** The variable it comes from. */
  from: string
}

/** The proxy for a URL of the relay (http, https, ws or wss), or null when the connection goes direct. */
export function proxyFor(target: string, env: Env = process.env): Proxy | null {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return null
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  if (!secure && url.protocol !== 'http:' && url.protocol !== 'ws:') return null
  const from = PROXY_NAMES[secure ? 'https' : 'http'].find(name => env[name]?.trim())
  const value = from ? env[from]?.trim() : undefined
  if (!from || !value || bypassesProxy(url, firstSet(env, NO_PROXY_NAMES))) return null
  // fetch takes `proxy:3128` as an HTTP proxy. The WebSocket client throws on the kinds it can't speak (SOCKS).
  const proxy = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
  return /^https?:\/\//i.test(proxy) && URL.canParse(proxy) ? { url: proxy, from } : null
}

/**
 * NO_PROXY lists hosts and domains (`example.com` covers its subdomains too, a leading `.` or `*.` changes nothing),
 * optionally with a port, IPv4 ranges like `10.0.0.0/8`, or `*` for every host.
 */
export function bypassesProxy(url: URL, list: string): boolean {
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
  const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80')
  return list.split(',').some(item => {
    const entry = item.trim().toLowerCase()
    if (entry === '*') return true
    const [name, entryPort] = splitPort(entry)
    if (!name || (entryPort && entryPort !== port)) return false
    if (name.includes('/')) return inRange(host, name)
    const domain = name.replace(/^\*?\./, '').replace(/\.$/, '')
    return domain !== '' && (host === domain || host.endsWith(`.${domain}`))
  })
}

/** The proxy variables set in this environment, to hand down to the background service. */
export function proxyEnvironment(env: Env = process.env): [string, string][] {
  return PROXY_VARIABLES.flatMap(name => {
    const value = env[name]?.trim()
    return value ? [[name, value] as [string, string]] : []
  })
}

/** For logs and `tonton status`: the proxy without the password its address may carry. */
export function shownProxy(proxy: string): string {
  try {
    const url = new URL(proxy)
    url.username = ''
    url.password = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return 'an address that is not a URL'
  }
}

function firstSet(env: Env, names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return ''
}

function splitPort(entry: string): [string, string | null] {
  const bracketed = /^\[([^\]]*)\](?::(\d+))?$/.exec(entry)
  if (bracketed) return [bracketed[1], bracketed[2] ?? null]
  const withPort = /^([^:]+):(\d+)$/.exec(entry)
  return withPort ? [withPort[1], withPort[2]] : [entry, null]
}

function inRange(host: string, range: string): boolean {
  const [base, bits] = range.split('/')
  const prefix = Number(bits)
  const address = ipv4(host)
  const network = ipv4(base)
  if (address === null || network === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (address & mask) >>> 0 === (network & mask) >>> 0
}

function ipv4(text: string): number | null {
  const parts = text.split('.')
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null
  return parts.reduce((total, part) => total * 256 + Number(part), 0)
}
