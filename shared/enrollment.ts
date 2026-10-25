// The connection code the app gives for a new machine: `<code>.<key>@<relay>`. The code is a single-use credential for
// the relay, the key is the account's end-to-end key and never leaves the machine. Codes from before 0.4.0 have no relay.

export interface Enrollment {
  code: string
  key: string
  server: string | null
}

const ENROLLMENT = /^([A-Z0-9]{12})\.([A-Za-z0-9_-]{43})(?:@(https?:\/\/[^\s@]+))?$/

export function parseEnrollment(text: string): Enrollment | null {
  const match = ENROLLMENT.exec(text.trim())
  if (!match) return null
  return { code: match[1], key: match[2], server: match[3] ? normalizeServer(match[3]) : null }
}

/** `https://relay.example.com/` and `https://relay.example.com` are the same relay. Null for anything but http(s). */
export function normalizeServer(text: string): string | null {
  try {
    const url = new URL(text.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}
