import { join } from 'node:path'

export interface RelayConfig {
  port: number
  /** Public HTTPS address used in install scripts. Falls back to the request host. */
  publicUrl: string | null
  distDir: string
  dataDir: string
  registration: 'open' | 'closed'
  /** Required to create accounts when registration is closed. */
  adminToken: string | null
  /** Trust X-Forwarded-For. Only enable behind a reverse proxy that sets it. */
  trustProxy: boolean
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const root = join(import.meta.dir, '../..')
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
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, '') : null,
    distDir: env.DIST_DIR ?? join(root, 'dist'),
    dataDir: env.TONTON_DATA_DIR ?? join(root, 'data'),
    registration,
    adminToken,
    trustProxy: env.TONTON_TRUST_PROXY === '1',
  }
}
