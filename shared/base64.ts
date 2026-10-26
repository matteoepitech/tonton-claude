// Base64 without Node's Buffer, so the client core runs in browsers as well as in Bun. Decoding throws on anything that is
// not base64, like Swift's `Data(base64Encoded:)`; padding is optional.

const CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  // String.fromCharCode takes its bytes as arguments: chunks keep large images under the engines' argument limit.
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Takes the standard alphabet too, like Node's `Buffer.from(text, 'base64url')`. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  return base64ToBytes(text.replace(/-/g, '+').replace(/_/g, '/'))
}

export const utf8ToBase64Url = (text: string) => bytesToBase64Url(new TextEncoder().encode(text))

/** Throws on invalid base64url or UTF-8. */
export const base64UrlToUtf8 = (text: string) => new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(text))
