import type { Server } from 'bun'
import type { HookPost, PushDevice, PushStatus } from '../../shared/protocol'
import { RELEASES_URL } from '../../shared/version'
import type { RelayContext } from './context'
import { BROWSER_PROTOCOL, bearerToken, browserToken, clientIp, fail, json, readJson } from './http'
import type { SocketData } from './hub'
import { MAX_SHARE_HOURS } from './limits'
import { renderMetrics } from './metrics'
import { siteResponse } from './site'
import { safeEqual, sha256 } from './tokens'
import { isDeviceId, isPushToken, isSealed, isSessionId, isText, isVersion } from './validate'

type RelayServer = Server<SocketData>

const MACHINE_PATH = /^\/api\/machines\/([A-Za-z0-9_-]{12})$/
const SHARE_PATH = /^\/api\/shares\/([A-Za-z0-9_-]{12})$/
const DEVICE_PATH = /^\/api\/push\/devices\/([A-Za-z0-9-]{8,64})$/

export function createFetchHandler(ctx: RelayContext) {
  return async (req: Request, server: RelayServer): Promise<Response | undefined> => {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/health') return new Response('ok')
    if (path === '/metrics') return metrics(ctx, req, clientIp(req, server, ctx.config.trustProxy))
    // Agents and install scripts used to be served here: they are published with the releases now. Old commands that
    // update an enrolled machine (`irm <relay>/install.ps1 | iex`) keep working.
    if (path === '/install.sh' || path === '/install.ps1') return Response.redirect(`${RELEASES_URL}/latest/download${path}`, 302)
    if (path.startsWith('/dl/')) return Response.redirect(`${RELEASES_URL}/latest`, 302)
    if (!path.startsWith('/api/') && !path.startsWith('/ws/')) return (await siteResponse(req, path)) ?? fail(404, 'not found')

    const ip = clientIp(req, server, ctx.config.trustProxy)
    if (ctx.failedAuth.isBlocked(ip)) return fail(429, 'Too many failed attempts, try again later.')

    if (path === '/api/accounts' && req.method === 'POST') return createAccount(ctx, req, ip)
    if (path === '/api/machines/join' && req.method === 'POST') return joinMachine(ctx, req, ip)
    if (path === '/api/hook' || path === '/api/agent/ping' || path === '/ws/agent') return agentRoute(ctx, req, server, path, ip)
    if (path === '/ws/share') return viewerRoute(ctx, req, server, ip)
    return appRoute(ctx, req, server, path, ip)
  }
}

/** Off unless the operator set a token: how busy the relay is concerns them only. */
function metrics(ctx: RelayContext, req: Request, ip: string): Response {
  const token = ctx.config.metricsToken
  if (!token) return fail(404, 'not found')
  if (ctx.failedAuth.isBlocked(ip)) return fail(429, 'Too many failed attempts, try again later.')
  if (!safeEqual(sha256(bearerToken(req)), sha256(token))) {
    ctx.failedAuth.hit(ip)
    return fail(401, 'unauthorized')
  }
  const headers = { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' }
  return new Response(renderMetrics(ctx.counts()), { headers })
}

function createAccount(ctx: RelayContext, req: Request, ip: string): Response {
  const { registration, adminToken } = ctx.config
  if (registration === 'closed' && bearerToken(req) !== adminToken) return fail(403, 'Registration is closed on this relay.')
  if (!ctx.signups.hit(ip)) return fail(429, 'Too many accounts created from this address.')
  const account = ctx.registry.createAccount()
  return json({ accountId: account.id, token: account.token })
}

async function joinMachine(ctx: RelayContext, req: Request, ip: string): Promise<Response> {
  if (!ctx.claims.hit(ip)) return fail(429, 'Too many attempts to join.')
  const body = await readJson<{ account?: unknown; secret?: unknown; name?: unknown }>(req, 16_384)
  if (!isText(body?.account, 32) || !isText(body?.secret, 64) || !isSealed(body?.name, 4096)) return fail(400, 'Bad request.')

  const result = ctx.registry.joinMachine(body.account, body.secret, body.name)
  if (!result.ok && result.reason === 'machine-limit') return fail(403, 'This account reached its machine limit.')
  if (!result.ok) {
    ctx.failedAuth.hit(ip)
    return fail(401, 'This token is no longer valid. Copy the current one from Tonton Claude › Machines.')
  }
  ctx.pushMachines(result.machine.accountId)
  return json({ machineId: result.machine.id, token: result.token })
}

/** Creates the account token, or replaces it and signs out every machine that joined with the previous one. */
async function accountToken(ctx: RelayContext, req: Request, accountId: string): Promise<Response> {
  const body = await readJson<{ regenerate?: unknown }>(req, 1024)
  const result = ctx.registry.newJoinSecret(accountId, body?.regenerate === true)
  if (!result) return fail(409, 'This account already has a token. Copy it from the Mac where it was created, or regenerate it.')
  for (const machineId of result.revoked) {
    ctx.hub.disconnectMachine(machineId, 'token regenerated')
    ctx.forgetMachine(machineId)
    ctx.sessions.removeMachine(accountId, machineId)
  }
  if (result.revoked.length) ctx.pushMachines(accountId)
  return json({ secret: result.secret })
}

async function agentRoute(ctx: RelayContext, req: Request, server: RelayServer, path: string, ip: string): Promise<Response | undefined> {
  const machine = ctx.registry.authenticateMachine(bearerToken(req))
  if (!machine) {
    ctx.failedAuth.hit(ip)
    return fail(401, 'unauthorized')
  }
  if (path === '/api/agent/ping') return json({ ok: true, machineId: machine.id })
  if (path === '/ws/agent') {
    const version = req.headers.get('x-tonton-agent')
    const data: SocketData = {
      role: 'agent',
      accountId: machine.accountId,
      machineId: machine.id,
      sessionId: null,
      agentVersion: isVersion(version) ? version : null,
      service: req.headers.get('x-tonton-role') === 'service',
    }
    return server.upgrade(req, { data }) ? undefined : fail(400, 'WebSocket expected.')
  }

  const body = await readJson<HookPost>(req, 131_072)
  if (!isSessionId(body?.event?.session_id) || !isText(body.event.hook_event_name, 64)) return fail(400, 'Bad request.')
  if (body.detail !== undefined && !isSealed(body.detail, 65_536)) return fail(400, 'Bad request.')
  ctx.sessions.applyHook(machine.accountId, machine.id, body)
  return new Response('ok')
}

/** A teammate opening a read-only share: its token opens that share and nothing else. */
function viewerRoute(ctx: RelayContext, req: Request, server: RelayServer, ip: string): Response | undefined {
  const share = ctx.registry.authenticateShare(bearerToken(req))
  if (!share) {
    ctx.failedAuth.hit(ip)
    return fail(401, 'This share was revoked or has expired.')
  }
  const data: SocketData = {
    role: 'viewer',
    accountId: share.accountId,
    machineId: null,
    sessionId: share.sessionId,
    agentVersion: null,
    service: false,
    shareId: share.id,
  }
  const headers: Record<string, string> = browserToken(req) ? { 'sec-websocket-protocol': BROWSER_PROTOCOL } : {}
  return server.upgrade(req, { data, headers }) ? undefined : fail(400, 'WebSocket expected.')
}

/** A share of one of the account's sessions, for `hours`. The app then sends its order, sealed, for the agent. */
async function createShare(ctx: RelayContext, req: Request, accountId: string): Promise<Response> {
  const body = await readJson<{ sessionId?: unknown; hours?: unknown }>(req, 1024)
  const hours = body?.hours
  if (!isSessionId(body?.sessionId) || typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > MAX_SHARE_HOURS) {
    return fail(400, 'Bad request.')
  }
  const sessionId = body.sessionId
  if (!ctx.sessions.list(accountId).some(session => session.id === sessionId)) return fail(404, 'No such session.')
  const created = ctx.registry.createShare(accountId, sessionId, Date.now() + hours * 3_600_000)
  if (!created) return fail(403, 'This account reached its share limit. Revoke one in Settings › Relay.')
  return json({ id: created.share.id, token: created.token, expiresAt: new Date(created.share.expiresAt).toISOString() })
}

/** What an iPhone wants pushed. Without an APNs key the relay keeps nothing and says so. */
async function registerDevice(ctx: RelayContext, req: Request, accountId: string): Promise<Response> {
  const body = await readJson<Partial<Record<keyof PushDevice, unknown>>>(req, 4096)
  const token = (value: unknown): string | null | undefined =>
    value === null || value === undefined ? null : isPushToken(value) ? value : undefined
  const [alert, activity, activityStart] = [token(body?.alert), token(body?.activity), token(body?.activityStart)]
  const environment = body?.environment
  if (!isDeviceId(body?.device) || (environment !== 'sandbox' && environment !== 'production')) return fail(400, 'Bad request.')
  if (alert === undefined || activity === undefined || activityStart === undefined) return fail(400, 'Bad request.')
  if (!ctx.push) return json({ enabled: false } satisfies PushStatus)
  ctx.push.register(accountId, { device: body.device, environment, alert, activity, activityStart })
  return json({ enabled: true } satisfies PushStatus)
}

async function appRoute(ctx: RelayContext, req: Request, server: RelayServer, path: string, ip: string): Promise<Response | undefined> {
  const accountId = ctx.registry.authenticateAccount(bearerToken(req))
  if (!accountId) {
    ctx.failedAuth.hit(ip)
    return fail(401, 'unauthorized')
  }

  if (path === '/ws/app') {
    const header = req.headers.get('x-tonton-device')
    const device = isDeviceId(header) ? header : null
    const data: SocketData = { role: 'app', accountId, machineId: null, sessionId: null, agentVersion: null, service: false, device }
    // The app shows the region next to the latency it measures with WebSocket pings.
    const headers: Record<string, string> = ctx.config.region ? { 'x-tonton-region': ctx.config.region } : {}
    // A browser must get one of the subprotocols it offered back: the one without the token.
    if (browserToken(req)) headers['sec-websocket-protocol'] = BROWSER_PROTOCOL
    return server.upgrade(req, { data, headers }) ? undefined : fail(400, 'WebSocket expected.')
  }
  if (path === '/api/ping') return json({ ok: true, accountId })
  if (path === '/api/account/token' && req.method === 'POST') return accountToken(ctx, req, accountId)
  if (path === '/api/machines' && req.method === 'GET') return json(ctx.machineList(accountId))
  if (path === '/api/shares' && req.method === 'POST') return createShare(ctx, req, accountId)
  if (path === '/api/shares' && req.method === 'GET') return json(ctx.shareList(accountId))
  if (path === '/api/push' && req.method === 'GET') return json({ enabled: ctx.push !== null } satisfies PushStatus)
  if (path === '/api/push/devices' && req.method === 'POST') return registerDevice(ctx, req, accountId)

  const devicePath = DEVICE_PATH.exec(path)
  if (devicePath && req.method === 'DELETE') {
    ctx.push?.unregister(accountId, devicePath[1])
    return json({ ok: true })
  }

  const sharePath = SHARE_PATH.exec(path)
  if (sharePath && req.method === 'DELETE') {
    const share = ctx.registry.revokeShare(accountId, sharePath[1])
    if (!share) return fail(404, 'No such share.')
    ctx.endShare(share, 'revoked')
    return json({ ok: true })
  }

  const machinePath = MACHINE_PATH.exec(path)
  if (machinePath && req.method === 'DELETE') {
    const machineId = machinePath[1]
    if (!ctx.registry.revokeMachine(accountId, machineId)) return fail(404, 'No such machine.')
    ctx.hub.disconnectMachine(machineId, 'revoked')
    ctx.forgetMachine(machineId)
    ctx.sessions.removeMachine(accountId, machineId)
    ctx.pushMachines(accountId)
    return json({ ok: true })
  }

  if (path === '/api/account' && req.method === 'DELETE') {
    for (const machine of ctx.registry.machines(accountId)) {
      ctx.hub.disconnectMachine(machine.id, 'account deleted')
      ctx.forgetMachine(machine.id)
    }
    for (const share of ctx.registry.shares(accountId)) ctx.endShare(share, 'account deleted')
    ctx.hub.disconnectApps(accountId, 'account deleted')
    ctx.registry.deleteAccount(accountId)
    ctx.sessions.removeAccount(accountId)
    return json({ ok: true })
  }
  return fail(404, 'not found')
}
