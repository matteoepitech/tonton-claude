import type { Server } from 'bun'
import type { HookPost } from '../../shared/protocol'
import { RELEASES_URL } from '../../shared/version'
import type { RelayContext } from './context'
import { bearerToken, clientIp, fail, json, readJson } from './http'
import type { SocketData } from './hub'
import { isSealed, isSessionId, isText, isVersion } from './validate'

type RelayServer = Server<SocketData>

const MACHINE_PATH = /^\/api\/machines\/([A-Za-z0-9_-]{12})$/

export function createFetchHandler(ctx: RelayContext) {
  return async (req: Request, server: RelayServer): Promise<Response | undefined> => {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/health') return new Response('ok')
    // Agents and install scripts used to be served here: they are published with the releases now. Old commands that
    // update an enrolled machine (`irm <relay>/install.ps1 | iex`) keep working.
    if (path === '/install.sh' || path === '/install.ps1') return Response.redirect(`${RELEASES_URL}/latest/download${path}`, 302)
    if (path.startsWith('/dl/')) return Response.redirect(`${RELEASES_URL}/latest`, 302)
    if (!path.startsWith('/api/') && !path.startsWith('/ws/')) return fail(404, 'not found')

    const ip = clientIp(req, server, ctx.config.trustProxy)
    if (ctx.failedAuth.isBlocked(ip)) return fail(429, 'Too many failed attempts, try again later.')

    if (path === '/api/accounts' && req.method === 'POST') return createAccount(ctx, req, ip)
    if (path === '/api/machines/join' && req.method === 'POST') return joinMachine(ctx, req, ip)
    if (path === '/api/hook' || path === '/api/agent/ping' || path === '/ws/agent') return agentRoute(ctx, req, server, path, ip)
    return appRoute(ctx, req, server, path, ip)
  }
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

async function appRoute(ctx: RelayContext, req: Request, server: RelayServer, path: string, ip: string): Promise<Response | undefined> {
  const accountId = ctx.registry.authenticateAccount(bearerToken(req))
  if (!accountId) {
    ctx.failedAuth.hit(ip)
    return fail(401, 'unauthorized')
  }

  if (path === '/ws/app') {
    const data: SocketData = { role: 'app', accountId, machineId: null, sessionId: null, agentVersion: null, service: false }
    // The app shows the region next to the latency it measures with WebSocket pings.
    const headers = ctx.config.region ? { 'x-tonton-region': ctx.config.region } : undefined
    return server.upgrade(req, { data, headers }) ? undefined : fail(400, 'WebSocket expected.')
  }
  if (path === '/api/ping') return json({ ok: true, accountId })
  if (path === '/api/account/token' && req.method === 'POST') return accountToken(ctx, req, accountId)
  if (path === '/api/machines' && req.method === 'GET') return json(ctx.machineList(accountId))

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
    ctx.hub.disconnectApps(accountId, 'account deleted')
    ctx.registry.deleteAccount(accountId)
    ctx.sessions.removeAccount(accountId)
    return json({ ok: true })
  }
  return fail(404, 'not found')
}
