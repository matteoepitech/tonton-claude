import type { Sealed } from '../../shared/protocol'

// AES-256-GCM with the account key, shared with the Mac app (CryptoKit).
// Wire format: base64(nonce[12] | ciphertext | tag[16]), the layout of AES.GCM.SealedBox.combined.

const AAD = new TextEncoder().encode('tonton/v1')
const keys = new Map<string, Promise<CryptoKey>>()

function importKey(keyBase64Url: string): Promise<CryptoKey> {
  let key = keys.get(keyBase64Url)
  if (!key) {
    const raw = Buffer.from(keyBase64Url, 'base64url')
    if (raw.length !== 32) throw new Error('the account key must be 32 bytes')
    key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    keys.set(keyBase64Url, key)
  }
  return key
}

export async function seal(keyBase64Url: string, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const key = await importKey(keyBase64Url)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plaintext)
  return Buffer.concat([iv, new Uint8Array(ciphertext)]).toString('base64')
}

/** Throws when the blob was not sealed with this key or was tampered with. */
export async function open<T>(keyBase64Url: string, blob: Sealed): Promise<T> {
  const data = Buffer.from(blob, 'base64')
  const key = await importKey(keyBase64Url)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: AAD }, key, data.subarray(12))
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}
