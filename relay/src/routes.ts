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
    if (path === '/api/machines/claim' && req.method === 'POST') return claimMachine(ctx, req, ip)
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

async function claimMachine(ctx: RelayContext, req: Request, ip: string): Promise<Response> {
  if (!ctx.claims.hit(ip)) return fail(429, 'Too many enrollment attempts.')
  const body = await readJson<{ code?: unknown; name?: unknown }>(req, 16_384)
  if (!isText(body?.code, 32) || !isSealed(body?.name, 4096)) return fail(400, 'Bad request.')

  const result = ctx.registry.claimEnrollment(body.code, body.name)
  if (!result.ok && result.reason === 'machine-limit') return fail(403, 'This account reached its machine limit.')
  if (!result.ok) {
    ctx.failedAuth.hit(ip)
    return fail(401, 'Unknown or expired code. Create a new one from the app.')
  }
  ctx.pushMachines(result.machine.accountId)
  return json({ machineId: result.machine.id, token: result.token })
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

function appRoute(ctx: RelayContext, req: Request, server: RelayServer, path: string, ip: string): Response | undefined {
  const accountId = ctx.registry.authenticateAccount(bearerToken(req))
  if (!accountId) {
    ctx.failedAuth.hit(ip)
    return fail(401, 'unauthorized')
  }

  if (path === '/ws/app') {
    const data: SocketData = { role: 'app', accountId, machineId: null, sessionId: null, agentVersion: null, service: false }
    return server.upgrade(req, { data }) ? undefined : fail(400, 'WebSocket expected.')
  }
  if (path === '/api/ping') return json({ ok: true, accountId })
  if (path === '/api/enrollments' && req.method === 'POST') return json(ctx.registry.createEnrollment(accountId))
  if (path === '/api/machines' && req.method === 'GET') return json(ctx.machineList(accountId))

  const machinePath = MACHINE_PATH.exec(path)
  if (machinePath && req.method === 'DELETE') {
    const machineId = machinePath[1]
    if (!ctx.registry.revokeMachine(accountId, machineId)) return fail(404, 'No such machine.')
    ctx.hub.disconnectMachine(machineId, 'revoked')
    ctx.agentVersions.delete(machineId)
    ctx.sessions.removeMachine(accountId, machineId)
    ctx.pushMachines(accountId)
    return json({ ok: true })
  }

  if (path === '/api/account' && req.method === 'DELETE') {
    for (const machine of ctx.registry.machines(accountId)) {
      ctx.hub.disconnectMachine(machine.id, 'account deleted')
      ctx.agentVersions.delete(machine.id)
    }
    ctx.hub.disconnectApps(accountId, 'account deleted')
    ctx.registry.deleteAccount(accountId)
    ctx.sessions.removeAccount(accountId)
    return json({ ok: true })
  }
  return fail(404, 'not found')
}
