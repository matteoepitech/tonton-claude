import { join } from 'node:path'

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
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const registration = env.TONTON_REGISTRATION ?? 'open'
  if (registration !== 'open' && registration !== 'closed') {
    throw new Error(`TONTON_REGISTRATION must be "open" or "closed", got "${registration}"`)
  }
  const adminToken = env.TONTON_ADMIN_TOKEN || null
  if (registration === 'closed' && (!adminToken || adminToken.length < 24)) {
    throw new Error('TONTON_ADMIN_TOKEN (24+ characters) is required when registration is closed')
  }
  const port = Number(env.PORT ?? 7777)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid PORT "${env.PORT}"`)

  return {
    port,
    dataDir: env.TONTON_DATA_DIR ?? join(process.cwd(), 'data'),
    registration,
    adminToken,
    trustProxy: env.TONTON_TRUST_PROXY === '1',
    region: (env.TONTON_REGION || env.FLY_REGION || '').trim().slice(0, 40) || null,
  }
}
