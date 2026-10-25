// The account token, like a RustDesk server key: what an agent needs to join an account. The app shows it in
// Machines; it goes into the install command or the agent's tray. `tonton_` followed by base64url JSON.

export interface AccountToken {
  /** Address of the relay. */
  relay: string
  account: string
  /** Lets machines join the account. The relay keeps a hash; regenerating it signs every machine out. */
  secret: string
  /** End-to-end key of the account. Never sent to the relay. */
  key: string
}

const PREFIX = 'tonton_'
const ID = /^[A-Za-z0-9_-]{12}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/

export function encodeAccountToken(token: AccountToken): string {
  return PREFIX + Buffer.from(JSON.stringify(token)).toString('base64url')
}

export function parseAccountToken(text: string): AccountToken | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PREFIX)) return null
  try {
    const token = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8')) as Partial<AccountToken>
    const relay = normalizeRelay(String(token.relay ?? ''))
    if (!relay || !ID.test(String(token.account)) || !SECRET.test(String(token.secret)) || !SECRET.test(String(token.key))) return null
    return { relay, account: String(token.account), secret: String(token.secret), key: String(token.key) }
  } catch {
    return null
  }
}

/** `https://relay.example.com/` and `https://relay.example.com` are the same relay. Null for anything but http(s). */
export function normalizeRelay(text: string): string | null {
  try {
    const url = new URL(text.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}
