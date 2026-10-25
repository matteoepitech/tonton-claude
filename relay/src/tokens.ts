import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Tokens are `<kind>_<id>_<secret>`. The id locates the row, only a hash of the secret is stored.
export type TokenKind = 'ta' | 'tm' // account (Mac app), machine (agent)

const ID_BYTES = 9 // 12 base64url characters
const SECRET_BYTES = 32 // 43 base64url characters

export interface IssuedToken {
  id: string
  token: string
  secretHash: Uint8Array
}

export function issueToken(kind: TokenKind): IssuedToken {
  const id = randomBytes(ID_BYTES).toString('base64url')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return { id, token: `${kind}_${id}_${secret}`, secretHash: sha256(secret) }
}

export function parseToken(token: string, kind: TokenKind): { id: string; secretHash: Uint8Array } | null {
  const match = new RegExp(`^${kind}_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$`).exec(token)
  return match ? { id: match[1], secretHash: sha256(match[2]) } : null
}

export function sha256(value: string): Uint8Array {
  return createHash('sha256').update(value).digest()
}

export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The secret of an account token, which lets machines join the account. */
export function newJoinSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}
