// The keys of a pool over time (docs/pools.md, Keys). Each member has a P-256 key pair for the pool: its public key is
// published sealed with the pool key, so the relay cannot swap it, and its private key is kept on the relay sealed with
// the member's account key. Rotating the pool key (when someone is kicked) wraps the new key for each remaining member
// with ECDH between the admin's private key and the member's public key, then HKDF-SHA256 and AES-256-GCM: only that
// admin could have made the wrap, and only that member can open it. Blobs sealed with a later key version say so with a
// `2:` prefix; version 1 has none, so blobs from before rotation existed read as they did.
// WebCrypto only, like crypto.ts. Mirrors app/Sources/TontonCore/PoolKeys.swift: the same curve, the same HKDF salt and
// info, the same layout.

import { base64UrlToBytes, bytesToBase64Url } from './base64'
import { type AccountKey, open, seal } from './crypto'
import type { Sealed } from './protocol'

const KEY = /^[A-Za-z0-9_-]{43}$/
const SALT = new TextEncoder().encode('tonton/pool')
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const

/** A member's private key for one pool, as JWK coordinates (base64url): what it keeps sealed with its account key. */
export interface PoolMemberSecret {
  poolId: string
  d: string
  x: string
  y: string
}

/** A member's public key, sealed with the pool key and bound to its account, so it cannot be moved to another. */
export interface PoolMemberKey {
  poolId: string
  account: string
  /** Base64url of the uncompressed point, 65 bytes. */
  key: string
}

/** What a wrap holds once opened: a version of the pool key, for one member, from one admin. */
export interface PoolKeyWrap {
  poolId: string
  version: number
  key: string
  from: string
  to: string
}

/** A wrap as the relay keeps it for its member. */
export interface PoolKeyWrapWire {
  version: number
  /** The admin who made it, whose public key opens it with the member's private key. */
  from: string
  blob: Sealed
}

// MARK: Versioned blobs

/** The key version that sealed a blob: the number before `:`, or 1 without one. */
export function blobVersion(blob: string): number {
  const match = /^(\d{1,6}):/.exec(blob)
  return match ? Number(match[1]) : 1
}

const withoutVersion = (blob: string): string => blob.replace(/^\d{1,6}:/, '')

/** Seals with version `version` of the pool key, and says so in the blob after version 1. */
export async function sealVersioned(key: AccountKey, version: number, value: unknown): Promise<Sealed> {
  const sealed = await seal(key, value)
  return version === 1 ? sealed : `${version}:${sealed}`
}

/** Every version of a pool key this client holds, the latest one sealing. */
export class PoolKeyring {
  private readonly keys = new Map<number, string>()

  constructor(key?: string, version = 1) {
    if (key) this.add(version, key)
  }

  add(version: number, key: string) {
    if (Number.isInteger(version) && version >= 1 && KEY.test(key)) this.keys.set(version, key)
  }

  key(version: number): string | null {
    return this.keys.get(version) ?? null
  }

  /** The latest version held. */
  get version(): number {
    return Math.max(0, ...this.keys.keys())
  }

  get current(): string | null {
    return this.key(this.version)
  }

  versions(): number[] {
    return [...this.keys.keys()].sort((a, b) => a - b)
  }

  seal(value: unknown): Promise<Sealed> {
    const key = this.current
    if (!key) return Promise.reject(new Error('no pool key'))
    return sealVersioned(key, this.version, value)
  }

  /** Throws when the blob's version is not held, or it does not open with it. */
  open<T>(blob: string): Promise<T> {
    const key = this.key(blobVersion(blob))
    if (!key) return Promise.reject(new Error('no pool key for this version'))
    return open<T>(key, withoutVersion(blob))
  }
}

// MARK: Member keys

/** A new key pair for a member of a pool. */
export async function newPoolMemberSecret(poolId: string): Promise<PoolMemberSecret> {
  const pair = (await crypto.subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error('P-256 key without coordinates')
  return { poolId, d: jwk.d, x: jwk.x, y: jwk.y }
}

/** The uncompressed public point of a secret, base64url. */
export function publicKeyOf(secret: Pick<PoolMemberSecret, 'x' | 'y'>): string {
  const x = base64UrlToBytes(secret.x)
  const y = base64UrlToBytes(secret.y)
  const point = new Uint8Array(65)
  point[0] = 4
  point.set(x, 1)
  point.set(y, 33)
  return bytesToBase64Url(point)
}

export const sealPoolMemberSecret = (accountKey: AccountKey, secret: PoolMemberSecret): Promise<Sealed> => seal(accountKey, secret)

/** The member's private key, if it opens with the account key and is for this pool. */
export async function openPoolMemberSecret(
  accountKey: AccountKey,
  sealed: Sealed | null,
  poolId: string,
): Promise<PoolMemberSecret | null> {
  if (!sealed) return null
  const secret = await open<Partial<PoolMemberSecret>>(accountKey, sealed).catch(() => null)
  if (secret?.poolId !== poolId || !isCoordinate(secret.d) || !isCoordinate(secret.x) || !isCoordinate(secret.y)) return null
  return { poolId, d: secret.d, x: secret.x, y: secret.y }
}

export function sealPoolMemberKey(keyring: PoolKeyring, poolId: string, account: string, secret: PoolMemberSecret): Promise<Sealed> {
  const value: PoolMemberKey = { poolId, account, key: publicKeyOf(secret) }
  return keyring.seal(value)
}

/** A member's public key, if it opens with a version of the pool key and names that member of that pool. */
export async function openPoolMemberKey(
  keyring: PoolKeyring,
  sealed: Sealed | null,
  poolId: string,
  account: string,
): Promise<string | null> {
  if (!sealed) return null
  const value = await keyring.open<Partial<PoolMemberKey>>(sealed).catch(() => null)
  return value?.poolId === poolId && value.account === account && isPoint(value.key) ? value.key : null
}

const isCoordinate = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
const isPoint = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{87}$/.test(value)

// MARK: Wraps

/**
 * The AES key between two members for one version of one pool: ECDH, then HKDF-SHA256 with the pool's salt and an info
 * naming the pool, the version and both members, so a wrap opens for that purpose only.
 */
async function wrapKey(secret: PoolMemberSecret, peerPublic: string, wrap: Omit<PoolKeyWrap, 'key'>): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: secret.d, x: secret.x, y: secret.y, ext: true },
    P256,
    false,
    ['deriveBits'],
  )
  const publicKey = await crypto.subtle.importKey('raw', base64UrlToBytes(peerPublic), P256, false, [])
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
  const info = new TextEncoder().encode(`tonton/pool-key/v1|${wrap.poolId}|${wrap.version}|${wrap.from}|${wrap.to}`)
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info }, hkdf, 256)
  return bytesToBase64Url(new Uint8Array(bits))
}

/** Wraps a version of the pool key for a member, with the admin's private key and the member's public key. */
export async function wrapPoolKey(admin: PoolMemberSecret, memberPublic: string, wrap: PoolKeyWrap): Promise<Sealed> {
  return seal(await wrapKey(admin, memberPublic, wrap), wrap)
}

/**
 * The pool key a wrap holds, if this member can open it with the admin's public key and it says what was expected: this
 * pool, this version, from that admin, to this member.
 */
export async function unwrapPoolKey(
  member: PoolMemberSecret,
  adminPublic: string,
  sealed: Sealed,
  expected: Omit<PoolKeyWrap, 'key'>,
): Promise<string | null> {
  try {
    const wrap = await open<Partial<PoolKeyWrap>>(await wrapKey(member, adminPublic, expected), sealed)
    const matches =
      wrap.poolId === expected.poolId && wrap.version === expected.version && wrap.from === expected.from && wrap.to === expected.to
    return matches && typeof wrap.key === 'string' && KEY.test(wrap.key) ? wrap.key : null
  } catch {
    return null
  }
}

// MARK: A member's keyring

/** What a member needs to hold every version of the pool key it was given. */
export interface PoolKeySources {
  accountKey: AccountKey
  poolId: string
  /** This member's account. */
  account: string
  /** The version it joined with, from its own grant. */
  grant: { key: string; version: number }
  /** `PoolMemberSecret` sealed with the account key. */
  secret: Sealed | null
  wraps: readonly PoolKeyWrapWire[]
  /** Every member's public keys, to find the admin who made each wrap. */
  members: readonly { account: string; publicKeys: readonly Sealed[] }[]
}

/**
 * Every version of the pool key the member can open: the one it joined with, then each wrap in turn. A wrap opens with
 * the public key of the admin who made it, read with a version already held; that is why wraps go in order, and why
 * members publish their public key again with each new version.
 */
export async function resolvePoolKeyring(sources: PoolKeySources): Promise<{ keyring: PoolKeyring; secret: PoolMemberSecret | null }> {
  const keyring = new PoolKeyring(sources.grant.key, sources.grant.version)
  const secret = await openPoolMemberSecret(sources.accountKey, sources.secret, sources.poolId)
  if (!secret) return { keyring, secret: null }
  const pending = [...sources.wraps].filter(wrap => !keyring.key(wrap.version)).sort((a, b) => a.version - b.version)
  let progress = true
  while (pending.length && progress) {
    progress = false
    for (const wrap of [...pending]) {
      const admin = sources.members.find(member => member.account === wrap.from)
      const adminPublic = admin ? await firstPublicKey(keyring, admin.publicKeys, sources.poolId, wrap.from) : null
      if (!adminPublic) continue
      const expected = { poolId: sources.poolId, version: wrap.version, from: wrap.from, to: sources.account }
      const key = await unwrapPoolKey(secret, adminPublic, wrap.blob, expected)
      pending.splice(pending.indexOf(wrap), 1)
      if (key) {
        keyring.add(wrap.version, key)
        progress = true
      }
    }
  }
  return { keyring, secret }
}

/** The public key in the first of a member's blobs that opens with the keyring and names that member. */
export async function firstPublicKey(
  keyring: PoolKeyring,
  blobs: readonly Sealed[],
  poolId: string,
  account: string,
): Promise<string | null> {
  for (const blob of blobs) {
    const key = await openPoolMemberKey(keyring, blob, poolId, account)
    if (key) return key
  }
  return null
}

/** True when the member has not yet published its public key sealed with the keyring's latest version. */
export const needsRepublish = (keyring: PoolKeyring, publicKeys: readonly Sealed[]): boolean =>
  keyring.version > 0 && !publicKeys.some(blob => blobVersion(blob) === keyring.version)

/**
 * A rotation, as an admin makes it: a new pool key, wrapped for every member it can read the public key of, itself
 * included, minus `kick`. Who it could not wrap for is listed: they need a new invite.
 */
export async function preparePoolRotation(options: {
  keyring: PoolKeyring
  admin: PoolMemberSecret
  poolId: string
  account: string
  members: readonly { account: string; publicKeys: readonly Sealed[] }[]
  kick?: string
  newKey: string
}): Promise<{ version: number; wraps: { account: string; blob: Sealed }[]; skipped: string[] }> {
  const version = options.keyring.version + 1
  const wraps: { account: string; blob: Sealed }[] = []
  const skipped: string[] = []
  for (const member of options.members) {
    if (member.account === options.kick) continue
    const memberPublic =
      member.account === options.account
        ? publicKeyOf(options.admin)
        : await firstPublicKey(options.keyring, member.publicKeys, options.poolId, member.account)
    if (!memberPublic) {
      skipped.push(member.account)
      continue
    }
    const wrap: PoolKeyWrap = { poolId: options.poolId, version, key: options.newKey, from: options.account, to: member.account }
    wraps.push({ account: member.account, blob: await wrapPoolKey(options.admin, memberPublic, wrap) })
  }
  return { version, wraps, skipped }
}
