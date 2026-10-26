import { base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToBase64Url } from './base64'
import type { Sealed } from './protocol'

// AES-256-GCM with the account key, shared with the Mac app (CryptoKit). WebCrypto only, so the same code runs in the
// agent, in browsers and in the other clients.
// Wire format: base64(nonce[12] | ciphertext | tag[16]), the layout of AES.GCM.SealedBox.combined.

/** The account key: base64url of its 32 bytes, or a key already imported with `importAccountKey`. */
export type AccountKey = string | CryptoKey

const AAD = new TextEncoder().encode('tonton/v1')
const NONCE_BYTES = 12
const keys = new Map<string, Promise<CryptoKey>>()

/** A new random account key, base64url encoded like the Mac app's `E2E.newKey()`. */
export function newAccountKey(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * Imports the base64url key. Not extractable by default: a client that keeps the `CryptoKey` (in IndexedDB, say) can
 * seal and open with it, but no script can read the key back out.
 */
export async function importAccountKey(keyBase64Url: string, extractable = false): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer> | null = null
  try {
    raw = base64UrlToBytes(keyBase64Url)
  } catch {}
  if (raw?.length !== 32) throw new Error('the account key must be 32 bytes')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', extractable, ['encrypt', 'decrypt'])
}

function cryptoKey(key: AccountKey): Promise<CryptoKey> {
  if (typeof key !== 'string') return Promise.resolve(key)
  let imported = keys.get(key)
  if (!imported) {
    imported = importAccountKey(key)
    keys.set(key, imported)
    // A bad key is not worth keeping: the next call fails the same way.
    imported.catch(() => keys.delete(key))
  }
  return imported
}

export async function seal(key: AccountKey, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await cryptoKey(key), plaintext)
  const combined = new Uint8Array(NONCE_BYTES + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), NONCE_BYTES)
  return bytesToBase64(combined)
}

/** Throws when the blob was not sealed with this key or was tampered with. */
export async function open<T>(key: AccountKey, blob: Sealed): Promise<T> {
  const data = base64ToBytes(blob)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.subarray(0, NONCE_BYTES), additionalData: AAD },
    await cryptoKey(key),
    data.subarray(NONCE_BYTES),
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}
