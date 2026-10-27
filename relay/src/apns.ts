// Apple Push Notification service: HTTP/2 to Apple, authenticated with a JWT signed by the APNs key of the team that
// publishes the iPhone app. https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
import http2 from 'node:http2'

export interface ApnsConfig {
  /** The .p8 key, PEM. */
  key: string
  /** Its 10-character id. */
  keyId: string
  teamId: string
  /** The iPhone app's bundle id. */
  topic: string
}

export type ApnsEnvironment = 'sandbox' | 'production'

export interface ApnsPush {
  /** The device or Live Activity token, hex. */
  token: string
  environment: ApnsEnvironment
  type: 'alert' | 'liveactivity'
  priority: 5 | 10
  payload: string
  /** Seconds since 1970 after which Apple drops the push instead of delivering it late. */
  expiration?: number
  /** Pushes with the same id replace each other on the phone. */
  collapseId?: string
}

/** `status` 0 when Apple could not be reached. `reason` is Apple's, e.g. `BadDeviceToken`. */
export interface ApnsResult {
  status: number
  reason: string | null
}

/** Sends pushes; the relay only depends on this, so tests can stand in for Apple. */
export interface Pusher {
  send(push: ApnsPush): Promise<ApnsResult>
  close(): void
}

export const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
}

/** Apple refuses a token older than an hour, and one renewed more often than every 20 minutes. */
const TOKEN_LIFETIME_MS = 40 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

export class ApnsClient implements Pusher {
  private token: { value: Promise<string>; at: number } | null = null
  private signingKey: Promise<CryptoKey> | null = null
  private readonly connections = new Map<ApnsEnvironment, http2.ClientHttp2Session>()

  constructor(
    private readonly config: ApnsConfig,
    private readonly origins: Record<ApnsEnvironment, string> = APNS_ORIGINS,
    private readonly now: () => number = Date.now,
  ) {}

  async send(push: ApnsPush): Promise<ApnsResult> {
    let token: string
    try {
      token = await this.providerToken()
    } catch {
      this.token = null
      return { status: 0, reason: 'InvalidKey' }
    }
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${push.token}`,
      authorization: `bearer ${token}`,
      'apns-topic': push.type === 'liveactivity' ? `${this.config.topic}.push-type.liveactivity` : this.config.topic,
      'apns-push-type': push.type,
      'apns-priority': String(push.priority),
      'content-type': 'application/json',
    }
    if (push.expiration !== undefined) headers['apns-expiration'] = String(push.expiration)
    if (push.collapseId) headers['apns-collapse-id'] = push.collapseId
    const result = await this.request(push.environment, headers, push.payload)
    if (result.status === 403 && result.reason === 'ExpiredProviderToken') this.token = null
    return result
  }

  close() {
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
  }

  /** The JWT Apple expects in `authorization`, renewed every 40 minutes. */
  private providerToken(): Promise<string> {
    const now = this.now()
    if (this.token && now - this.token.at < TOKEN_LIFETIME_MS) return this.token.value
    const value = this.sign(now)
    this.token = { value, at: now }
    return value
  }

  private async sign(now: number): Promise<string> {
    this.signingKey ??= crypto.subtle.importKey('pkcs8', pemBody(this.config.key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.config.keyId }))
    const claims = base64url(JSON.stringify({ iss: this.config.teamId, iat: Math.floor(now / 1000) }))
    const input = `${header}.${claims}`
    // WebCrypto signs ECDSA as r | s, the encoding JWTs use.
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await this.signingKey, new TextEncoder().encode(input))
    return `${input}.${Buffer.from(signature).toString('base64url')}`
  }

  private connection(environment: ApnsEnvironment): http2.ClientHttp2Session {
    const existing = this.connections.get(environment)
    if (existing && !existing.closed && !existing.destroyed) return existing
    const connection = http2.connect(this.origins[environment])
    const forget = () => {
      if (this.connections.get(environment) === connection) this.connections.delete(environment)
    }
    connection.on('error', forget)
    connection.on('goaway', forget)
    connection.on('close', forget)
    this.connections.set(environment, connection)
    return connection
  }

  private request(environment: ApnsEnvironment, headers: http2.OutgoingHttpHeaders, body: string): Promise<ApnsResult> {
    return new Promise(resolve => {
      let request: http2.ClientHttp2Stream | undefined
      let settled = false
      const timer = setTimeout(() => {
        request?.close()
        finish({ status: 0, reason: 'Timeout' })
      }, REQUEST_TIMEOUT_MS)
      const finish = (result: ApnsResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      try {
        request = this.connection(environment).request(headers)
      } catch {
        this.connections.delete(environment)
        finish({ status: 0, reason: 'Unreachable' })
        return
      }
      let status = 0
      let data = ''
      request.setEncoding('utf8')
      request.on('response', response => {
        status = Number(response[':status'])
      })
      request.on('data', (chunk: string) => {
        if (data.length < 4096) data += chunk
      })
      request.on('end', () => finish({ status, reason: reasonOf(data) }))
      request.on('error', () => finish({ status: 0, reason: 'Unreachable' }))
      request.end(body)
    })
  }
}

function reasonOf(body: string): string | null {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason
    return typeof reason === 'string' ? reason.slice(0, 64) : null
  } catch {
    return null
  }
}

/** The DER bytes of a PEM key. */
function pemBody(pem: string): ArrayBuffer {
  return new Uint8Array(Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64')).buffer
}

const base64url = (text: string) => Buffer.from(text).toString('base64url')
