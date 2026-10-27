import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApnsConfig } from './apns'

export interface RelayConfig {
  port: number
  dataDir: string
  registration: 'open' | 'closed'
  /** Required to create accounts when registration is closed. */
  adminToken: string | null
  /** Trust X-Forwarded-For. Only enable behind a reverse proxy that sets it. */
  trustProxy: boolean
  /** Where the relay runs, shown in the app next to the latency. Fly.io sets FLY_REGION. */
  region: string | null
  /** Bearer token that opens `/metrics`. Without one the page does not exist. */
  metricsToken: string | null
  /** Pushes to the iPhone app. Only the team that signs the app has a key it accepts: off unless set. */
  apns: ApnsConfig | null
}

/** The bundle id of the iPhone app published from this repository. */
export const DEFAULT_APNS_TOPIC = 'tech.d3l.tontonclaude.ios'

export function loadConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const registration = env.TONTON_REGISTRATION ?? 'open'
  if (registration !== 'open' && registration !== 'closed') {
    throw new Error(`TONTON_REGISTRATION must be "open" or "closed", got "${registration}"`)
  }
  const adminToken = env.TONTON_ADMIN_TOKEN || null
  if (registration === 'closed' && (!adminToken || adminToken.length < 24)) {
    throw new Error('TONTON_ADMIN_TOKEN (24+ characters) is required when registration is closed')
  }
  const metricsToken = env.TONTON_METRICS_TOKEN || null
  if (metricsToken && metricsToken.length < 24) throw new Error('TONTON_METRICS_TOKEN must be 24+ characters')
  const port = Number(env.PORT ?? 7777)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid PORT "${env.PORT}"`)

  return {
    port,
    dataDir: env.TONTON_DATA_DIR ?? join(process.cwd(), 'data'),
    registration,
    adminToken,
    trustProxy: env.TONTON_TRUST_PROXY === '1',
    region: (env.TONTON_REGION || env.FLY_REGION || '').trim().slice(0, 40) || null,
    metricsToken,
    apns: loadApns(env),
  }
}

/** The key comes from a .p8 file, or inline in the environment with its line breaks written `\n`. */
function loadApns(env: Record<string, string | undefined>): ApnsConfig | null {
  const keyFile = env.TONTON_APNS_KEY_FILE || null
  const inline = env.TONTON_APNS_KEY || null
  const keyId = env.TONTON_APNS_KEY_ID?.trim() || null
  const teamId = env.TONTON_APNS_TEAM_ID?.trim() || null
  if (!keyFile && !inline && !keyId && !teamId) return null
  if ((!keyFile && !inline) || !keyId || !teamId) {
    throw new Error('APNs needs TONTON_APNS_KEY_FILE (or TONTON_APNS_KEY), TONTON_APNS_KEY_ID and TONTON_APNS_TEAM_ID together')
  }
  const key = keyFile ? readFileSync(keyFile, 'utf8') : (inline ?? '').replaceAll('\\n', '\n')
  if (!key.includes('-----BEGIN PRIVATE KEY-----')) throw new Error('the APNs key must be the .p8 file Apple gives, in PEM')
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error(`TONTON_APNS_KEY_ID must be the 10-character key id, got "${keyId}"`)
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error(`TONTON_APNS_TEAM_ID must be the 10-character team id, got "${teamId}"`)
  const topic = env.TONTON_APNS_TOPIC?.trim() || DEFAULT_APNS_TOPIC
  if (!/^[A-Za-z0-9.-]{1,155}$/.test(topic)) throw new Error(`TONTON_APNS_TOPIC must be a bundle id, got "${topic}"`)
  return { key, keyId, teamId, topic }
}
