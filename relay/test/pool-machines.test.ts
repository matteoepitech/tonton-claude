// Pool machines on a real relay (docs/pool-autopilot.md): who may put a machine in a pool and take it out, the order
// that reaches its background service only, the machine attested on what its service writes, the sessions it starts,
// the orchestrator machine and the dispatch setting. Blobs stay opaque: the relay never opens what is sealed.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PoolUpdate } from '../../shared/pool-protocol'
import { loadConfig } from '../src/config'
import { startRelay } from '../src/main'

const dir = mkdtempSync(join(tmpdir(), 'tonton-pool-machines-'))
const relay = startRelay(loadConfig({ PORT: '0', TONTON_DATA_DIR: dir, TONTON_TRUST_PROXY: '1' }))
const base = `http://127.0.0.1:${relay.server.port}`
const sockets: WebSocket[] = []

afterAll(() => {
  for (const socket of sockets) socket.close()
  relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

interface Client {
  socket: WebSocket
  messages: { t: string; [field: string]: unknown }[]
  send(message: object): void
}

let addresses = 0
const fromNewAddress = () => ({ 'x-forwarded-for': `10.2.${Math.floor(++addresses / 250)}.${addresses % 250}` })

async function api(path: string, token: string | null, method = 'GET', body?: object) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...fromNewAddress() }
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, body: await response.json() }
}

async function connect(path: string, token: string, headers: Record<string, string> = {}): Promise<Client> {
  const socket = new WebSocket(`${base.replace('http', 'ws')}${path}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  } as never)
  sockets.push(socket)
  const client: Client = { socket, messages: [], send: message => socket.send(JSON.stringify(message)) }
  socket.onmessage = event => client.messages.push(JSON.parse(String(event.data)))
  await new Promise(resolve => (socket.onopen = resolve))
  return client
}

/** The background service of a machine: the connection pool machines are run by. */
const service = (token: string) => connect('/ws/agent', token, { 'x-tonton-role': 'service', 'x-tonton-agent': '0.9.0' })

async function eventually<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const value = read()
    if (value) return value
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}

type Of<T extends string> = Extract<PoolUpdate, { t: T }> & { t: T }
const all = <T extends string>(client: Client, t: T) => client.messages.filter(m => m.t === t) as unknown as Of<T>[]
const last = <T extends string>(client: Client, t: T) => all(client, t).at(-1)

/** An account, with its machines joined with the account token. */
async function account(machines = 1) {
  const created = (await api('/api/accounts', null, 'POST', {})).body as { accountId: string; token: string }
  const { secret } = (await api('/api/account/token', created.token, 'POST', {})).body
  const joined: { machineId: string; token: string }[] = []
  for (let i = 0; i < machines; i++) {
    joined.push((await api('/api/machines/join', null, 'POST', { account: created.accountId, secret, name: 'sealed-name' })).body)
  }
  return { id: created.accountId, token: created.token, machines: joined }
}

let ids = 0
async function pool(owner: { token: string }) {
  const id = `mpool${String(++ids).padStart(7, '0')}`
  const keys = { publicKey: 'public-owner', secret: 'secret-owner' }
  expect((await api('/api/pools', owner.token, 'POST', { id, info: 'sealed-info', key: 'sealed-grant', ...keys })).status).toBe(200)
  return id
}

async function enter(owner: { token: string }, member: { token: string }, id: string, role = 'member') {
  const invite = (await api(`/api/pools/${id}/invites`, owner.token, 'POST', { uses: 1, hours: 1, role })).body
  const joined = await api('/api/pools/join', member.token, 'POST', {
    invite: invite.token,
    key: 'sealed-grant',
    publicKey: 'public-member',
    secret: 'secret-member',
  })
  expect(joined.status).toBe(200)
}

const addMachine = (app: Client, poolId: string, machineId: string, order = 'sealed-machine-order') =>
  app.send({ t: 'pool_add_machine', poolId, machineId, order, profile: 'sealed-machine-profile' })

describe('pool machines on the relay', () => {
  test("a member puts its own machine in the pool; only that machine's service gets the order, now and on reconnecting", async () => {
    const owner = await account()
    const member = await account(1)
    const viewer = await account(1)
    const id = await pool(owner)
    await enter(owner, member, id)
    await enter(owner, viewer, id, 'viewer')
    const [machine] = member.machines
    const ownerApp = await connect('/ws/app', owner.token)
    const memberApp = await connect('/ws/app', member.token)
    const viewerApp = await connect('/ws/app', viewer.token)
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    const first = await eventually(() => last(ownerApp, 'pool_snapshot'), 'the snapshot')
    expect(first.pool.machines).toEqual([])
    expect(first.pool.orchestratorMachine).toBeNull()
    expect(first.pool.dispatch).toBeNull()

    // Another account's machine, and a viewer's own: refused.
    addMachine(ownerApp, id, machine.machineId)
    await eventually(() => last(ownerApp, 'pool_error')?.message.includes('No such machine'), 'not the owner’s machine')
    addMachine(viewerApp, id, viewer.machines[0].machineId)
    await eventually(() => last(viewerApp, 'pool_error')?.message.includes('Viewers'), 'not from a viewer')

    const channel = await connect('/ws/agent', machine.token)
    const svc = await service(machine.token)
    addMachine(memberApp, id, machine.machineId)
    const order = await eventually(() => last(svc, 'pool_machine_join'), 'the order at the service')
    expect(order as unknown).toEqual({ t: 'pool_machine_join', machineId: machine.machineId, poolId: id, order: 'sealed-machine-order' })
    // A session's channel on the same machine never gets it: the service runs pool machines.
    await Bun.sleep(100)
    expect(all(channel, 'pool_machine_join')).toEqual([])
    const shown = await eventually(() => last(ownerApp, 'pool_machine'), 'the machine for the members')
    expect(shown.machine).toMatchObject({ account: member.id, machine: machine.machineId, profile: 'sealed-machine-profile' })
    expect(shown.machine).toMatchObject({ online: true, ready: false })

    // The service acknowledges: it gets the pool, and the members see it ready.
    svc.send({ t: 'pool_machine_ack', machineId: machine.machineId, poolId: id })
    const snapshot = await eventually(() => last(svc, 'pool_snapshot'), 'the snapshot at the service')
    expect(snapshot.pool.machines?.map(m => m.machine)).toEqual([machine.machineId])
    await eventually(() => last(ownerApp, 'pool_machine')?.machine.ready, 'the machine ready')
    const audit = await eventually(() => all(ownerApp, 'pool_audit').find(m => m.entry.action === 'machine_added'), 'the audit line')
    expect(audit.entry).toMatchObject({ account: member.id, target: { account: member.id, machine: machine.machineId } })

    // Its service goes away: not ready; back, it gets the order again.
    svc.socket.close()
    await eventually(() => last(ownerApp, 'pool_machine')?.machine.ready === false, 'not ready')
    const again = await service(machine.token)
    await eventually(() => last(again, 'pool_machine_join'), 'the order again')
    // Every connection of the machine gone: offline.
    again.socket.close()
    channel.socket.close()
    await eventually(() => last(ownerApp, 'pool_machine')?.machine.online === false, 'offline')
  })

  test('what a machine’s service writes carries the machine; nobody else speaks for it', async () => {
    const owner = await account()
    const member = await account(2)
    const id = await pool(owner)
    await enter(owner, member, id)
    const [machine, other] = member.machines
    const ownerApp = await connect('/ws/app', owner.token)
    const memberApp = await connect('/ws/app', member.token)
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => last(ownerApp, 'pool_snapshot'), 'the snapshot')
    const svc = await service(machine.token)
    addMachine(memberApp, id, machine.machineId)
    await eventually(() => last(svc, 'pool_machine_join'), 'the order')
    svc.send({ t: 'pool_machine_ack', machineId: machine.machineId, poolId: id })
    await eventually(() => last(svc, 'pool_snapshot'), 'the snapshot at the service')

    svc.send({ t: 'pool_task', machineId: machine.machineId, poolId: id, id: 'mtask0001', rev: 0, blob: 'sealed-task' })
    const task = await eventually(() => last(ownerApp, 'pool_task'), 'the task')
    expect(task.task).toMatchObject({ account: member.id, session: null, machine: machine.machineId, rev: 1 })
    svc.send({ t: 'pool_event', machineId: machine.machineId, poolId: id, id: 'mevent0001', blob: 'sealed-event' })
    expect((await eventually(() => last(ownerApp, 'pool_event'), 'the event')).event).toMatchObject({ machine: machine.machineId })
    // The service gets the pool's changes, like a session's agent.
    await eventually(() => last(svc, 'pool_event'), 'the event at the service')
    // Notes are the sessions' and the members'.
    svc.send({ t: 'pool_notes', machineId: machine.machineId, poolId: id, rev: 0, blob: 'sealed-notes' })

    // A machine not in the pool, a channel posing as the service, another machine's id: dropped.
    const outsider = await service(other.token)
    outsider.send({ t: 'pool_task', machineId: other.machineId, poolId: id, id: 'mforged01', rev: 0, blob: 'x' })
    outsider.send({ t: 'pool_task', machineId: machine.machineId, poolId: id, id: 'mforged02', rev: 0, blob: 'x' })
    const channel = await connect('/ws/agent', machine.token)
    channel.send({ t: 'pool_task', machineId: machine.machineId, poolId: id, id: 'mforged03', rev: 0, blob: 'x' })
    await Bun.sleep(150)
    expect(all(ownerApp, 'pool_task').map(m => m.task.id)).toEqual(['mtask0001'])
    expect(all(ownerApp, 'pool_notes')).toEqual([])

    // Paused, it posts no task; it still says what happens.
    ownerApp.send({ t: 'pool_pause', poolId: id, paused: true })
    await eventually(() => last(ownerApp, 'pool_info')?.paused, 'paused')
    svc.send({ t: 'pool_task', machineId: machine.machineId, poolId: id, id: 'mtask0002', rev: 0, blob: 'sealed-task' })
    await eventually(() => last(svc, 'pool_error')?.message.includes('paused'), 'refused while paused')
    svc.send({ t: 'pool_event', machineId: machine.machineId, poolId: id, id: 'mevent0002', blob: 'sealed-event' })
    await eventually(() => all(ownerApp, 'pool_event').length === 2, 'the event while paused')
  })

  test('a machine puts in the pool the sessions it runs, and takes out only those', async () => {
    const owner = await account()
    const member = await account(2)
    const id = await pool(owner)
    await enter(owner, member, id)
    const [machine, other] = member.machines
    const ownerApp = await connect('/ws/app', owner.token)
    const memberApp = await connect('/ws/app', member.token)
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => last(ownerApp, 'pool_snapshot'), 'the snapshot')
    const svc = await service(machine.token)
    addMachine(memberApp, id, machine.machineId)
    await eventually(() => last(svc, 'pool_machine_join'), 'the order')
    svc.send({ t: 'pool_machine_ack', machineId: machine.machineId, poolId: id })

    // A worker session on this machine, one on the other machine, and one put in by hand.
    const worker = await connect('/ws/agent', machine.token)
    worker.send({ t: 'hello', sessionId: 'ses_worker', info: 'sealed-info', channel: true })
    const elsewhere = await connect('/ws/agent', other.token)
    elsewhere.send({ t: 'hello', sessionId: 'ses_elsewhere', info: 'sealed-info', channel: true })
    const byHand = await connect('/ws/agent', machine.token)
    byHand.send({ t: 'hello', sessionId: 'ses_byhand', info: 'sealed-info', channel: true })
    await Bun.sleep(100)

    const put = (sessionId: string) =>
      svc.send({
        t: 'pool_machine_session',
        machineId: machine.machineId,
        poolId: id,
        sessionId,
        order: 'sealed-order',
        profile: 'sealed-p',
      })
    put('ses_elsewhere')
    await eventually(() => last(svc, 'pool_error')?.message.includes('No such session on this machine'), 'not on this machine')
    put('ses_worker')
    const order = await eventually(() => last(worker, 'pool_join'), 'the order at the worker')
    expect(order as unknown).toEqual({ t: 'pool_join', sessionId: 'ses_worker', poolId: id, order: 'sealed-order' })
    const session = await eventually(() => all(ownerApp, 'pool_session').find(m => m.session.session === 'ses_worker'), 'the worker')
    expect(session.session.machine).toBe(machine.machineId)
    const joined = await eventually(() => all(ownerApp, 'pool_audit').find(m => m.entry.action === 'session_joined'), 'the audit')
    expect(joined.entry).toMatchObject({ account: member.id, session: null, machine: machine.machineId })

    memberApp.send({ t: 'pool_join_session', poolId: id, sessionId: 'ses_byhand', order: 'sealed-order', profile: 'sealed-p' })
    await eventually(() => all(ownerApp, 'pool_session').find(m => m.session.session === 'ses_byhand'), 'the session by hand')
    expect(all(ownerApp, 'pool_session').find(m => m.session.session === 'ses_byhand')?.session.machine).toBeUndefined()
    const leave = (sessionId: string) => svc.send({ t: 'pool_machine_session_left', machineId: machine.machineId, poolId: id, sessionId })
    leave('ses_byhand')
    leave('ses_worker')
    await eventually(() => last(worker, 'pool_left'), 'the worker out')
    await Bun.sleep(100)
    expect(all(ownerApp, 'pool_session_left').map(m => m.session)).toEqual(['ses_worker'])
    expect(all(byHand, 'pool_left')).toEqual([])

    // Taking the machine out takes the sessions it started with it, never the others.
    put('ses_worker')
    await eventually(() => all(worker, 'pool_join').length === 2, 'the worker in again')
    memberApp.send({ t: 'pool_remove_machine', poolId: id, machineId: machine.machineId })
    await eventually(() => last(svc, 'pool_machine_leave'), 'the service told')
    await eventually(() => all(worker, 'pool_left').length === 2, 'the worker out with it')
    const gone = await eventually(() => last(ownerApp, 'pool_machine_left'), 'the machine gone for the members')
    expect(gone).toMatchObject({ account: member.id, machine: machine.machineId })
    expect(all(byHand, 'pool_left')).toEqual([])
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => all(ownerApp, 'pool_snapshot').length === 2, 'a new snapshot')
    expect(last(ownerApp, 'pool_snapshot')?.pool.machines).toEqual([])
  })

  test('the orchestrator machine is one of an admin’s own; the session it starts plans for the pool', async () => {
    const owner = await account(1)
    const admin = await account(1)
    const member = await account(1)
    const id = await pool(owner)
    await enter(owner, admin, id, 'admin')
    await enter(owner, member, id)
    const ownerApp = await connect('/ws/app', owner.token)
    const adminApp = await connect('/ws/app', admin.token)
    const memberApp = await connect('/ws/app', member.token)
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => last(ownerApp, 'pool_snapshot'), 'the snapshot')
    const [adminMachine] = admin.machines
    const svc = await service(adminMachine.token)
    addMachine(adminApp, id, adminMachine.machineId)
    addMachine(memberApp, id, member.machines[0].machineId)
    await eventually(() => last(svc, 'pool_machine_join'), 'the order')
    svc.send({ t: 'pool_machine_ack', machineId: adminMachine.machineId, poolId: id })

    const choose = (app: Client, machine: { account: string; machine: string } | null) =>
      app.send({ t: 'pool_orchestrator_machine', poolId: id, machine })
    // A member may not choose; the owner may not choose another account's machine; nor a machine outside the pool.
    choose(memberApp, { account: member.id, machine: member.machines[0].machineId })
    await eventually(() => last(memberApp, 'pool_error')?.message.includes('owner and admins'), 'not a member')
    choose(ownerApp, { account: admin.id, machine: adminMachine.machineId })
    await eventually(() => last(ownerApp, 'pool_error')?.message.includes('your own'), 'not another’s machine')
    choose(ownerApp, { account: owner.id, machine: owner.machines[0].machineId })
    await eventually(() => all(ownerApp, 'pool_error').length === 2, 'not a machine outside the pool')
    choose(adminApp, { account: admin.id, machine: adminMachine.machineId })
    const chosen = await eventually(() => last(ownerApp, 'pool_orchestrator'), 'the orchestrator machine')
    expect(chosen).toMatchObject({ orchestrator: null, machine: { account: admin.id, machine: adminMachine.machineId } })

    // The session it starts says it is the orchestrator's: it becomes the orchestrator. Another machine's cannot.
    const lead = await connect('/ws/agent', adminMachine.token)
    lead.send({ t: 'hello', sessionId: 'ses_orch', info: 'sealed-info', channel: true })
    const memberService = await service(member.machines[0].token)
    const memberSession = await connect('/ws/agent', member.machines[0].token)
    memberSession.send({ t: 'hello', sessionId: 'ses_fake', info: 'sealed-info', channel: true })
    await Bun.sleep(100)
    memberService.send({ t: 'pool_machine_ack', machineId: member.machines[0].machineId, poolId: id })
    memberService.send({
      t: 'pool_machine_session',
      machineId: member.machines[0].machineId,
      poolId: id,
      sessionId: 'ses_fake',
      order: 'o',
      profile: 'p',
      orchestrator: true,
    })
    await eventually(() => last(memberSession, 'pool_join'), 'the member’s session in')
    expect(last(ownerApp, 'pool_orchestrator')?.orchestrator).toBeNull()
    svc.send({
      t: 'pool_machine_session',
      machineId: adminMachine.machineId,
      poolId: id,
      sessionId: 'ses_orch',
      order: 'o',
      profile: 'p',
      orchestrator: true,
    })
    const planned = await eventually(
      () => last(ownerApp, 'pool_orchestrator')?.orchestrator && last(ownerApp, 'pool_orchestrator'),
      'the lead',
    )
    expect(planned).toMatchObject({
      orchestrator: { account: admin.id, session: 'ses_orch' },
      machine: { machine: adminMachine.machineId },
    })

    // A session chosen by hand replaces it: there is one orchestrator.
    ownerApp.send({ t: 'pool_orchestrator', poolId: id, orchestrator: { account: member.id, session: 'ses_fake' } })
    const byHand = await eventually(
      () => last(ownerApp, 'pool_orchestrator')?.orchestrator?.session === 'ses_fake' && last(ownerApp, 'pool_orchestrator'),
      'by hand',
    )
    expect(byHand.machine).toBeNull()
    // Chosen again, the machine takes over from that session.
    choose(adminApp, { account: admin.id, machine: adminMachine.machineId })
    const back = await eventually(
      () => last(ownerApp, 'pool_orchestrator')?.machine && last(ownerApp, 'pool_orchestrator'),
      'the machine again',
    )
    expect(back?.orchestrator).toBeNull()
    // Taken out of the pool, it runs nothing.
    adminApp.send({ t: 'pool_remove_machine', poolId: id, machineId: adminMachine.machineId })
    await eventually(() => last(ownerApp, 'pool_orchestrator')?.machine === null, 'no orchestrator machine')
  })

  test('the dispatch: owners and admins, the orchestrator session and the orchestrator machine set it, over its revision', async () => {
    const owner = await account(1)
    const member = await account(1)
    const id = await pool(owner)
    await enter(owner, member, id)
    const ownerApp = await connect('/ws/app', owner.token)
    const memberApp = await connect('/ws/app', member.token)
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => last(ownerApp, 'pool_snapshot'), 'the snapshot')

    memberApp.send({ t: 'pool_dispatch', poolId: id, rev: 0, blob: 'sealed-on' })
    await eventually(() => last(memberApp, 'pool_error')?.message.includes('dispatch'), 'not a member')
    ownerApp.send({ t: 'pool_dispatch', poolId: id, rev: 0, blob: 'sealed-on' })
    const first = await eventually(() => last(ownerApp, 'pool_dispatch'), 'the dispatch')
    expect(first.dispatch).toMatchObject({ rev: 1, account: owner.id, session: null, blob: 'sealed-on' })
    ownerApp.send({ t: 'pool_dispatch', poolId: id, rev: 0, blob: 'sealed-late' })
    const conflict = await eventually(() => last(ownerApp, 'pool_conflict'), 'the conflict')
    expect(conflict).toMatchObject({ kind: 'dispatch', current: { rev: 1 } })

    // The orchestrator session, and no other session.
    const [machine] = owner.machines
    const lead = await connect('/ws/agent', machine.token)
    lead.send({ t: 'hello', sessionId: 'ses_lead', info: 'sealed-info', channel: true })
    const worker = await connect('/ws/agent', member.machines[0].token)
    worker.send({ t: 'hello', sessionId: 'ses_work', info: 'sealed-info', channel: true })
    await Bun.sleep(100)
    ownerApp.send({ t: 'pool_join_session', poolId: id, sessionId: 'ses_lead', order: 'o', profile: 'p' })
    memberApp.send({ t: 'pool_join_session', poolId: id, sessionId: 'ses_work', order: 'o', profile: 'p' })
    await eventually(() => all(ownerApp, 'pool_session').length >= 2, 'the sessions')
    ownerApp.send({ t: 'pool_orchestrator', poolId: id, orchestrator: { account: owner.id, session: 'ses_lead' } })
    await eventually(() => last(ownerApp, 'pool_orchestrator'), 'the orchestrator')
    worker.send({ t: 'pool_dispatch', sessionId: 'ses_work', poolId: id, rev: 1, blob: 'sealed-off' })
    await eventually(() => last(worker, 'pool_error')?.message.includes('orchestrator'), 'not a worker')
    lead.send({ t: 'pool_dispatch', sessionId: 'ses_lead', poolId: id, rev: 1, blob: 'sealed-off' })
    const second = await eventually(
      () => last(ownerApp, 'pool_dispatch')?.dispatch.rev === 2 && last(ownerApp, 'pool_dispatch'),
      'by the lead',
    )
    expect(second.dispatch).toMatchObject({ session: 'ses_lead' })

    // The orchestrator machine's control loop, and no other machine.
    const svc = await service(machine.token)
    const memberService = await service(member.machines[0].token)
    addMachine(ownerApp, id, machine.machineId)
    addMachine(memberApp, id, member.machines[0].machineId)
    await eventually(() => last(svc, 'pool_machine_join') && last(memberService, 'pool_machine_join'), 'the orders')
    ownerApp.send({ t: 'pool_orchestrator_machine', poolId: id, machine: { account: owner.id, machine: machine.machineId } })
    await eventually(() => last(ownerApp, 'pool_orchestrator')?.machine, 'the orchestrator machine')
    memberService.send({ t: 'pool_dispatch', machineId: member.machines[0].machineId, poolId: id, rev: 2, blob: 'sealed-x' })
    await eventually(() => last(memberService, 'pool_error')?.message.includes('orchestrator machine'), 'not another machine')
    svc.send({ t: 'pool_dispatch', machineId: machine.machineId, poolId: id, rev: 2, blob: 'sealed-done' })
    const third = await eventually(
      () => last(ownerApp, 'pool_dispatch')?.dispatch.rev === 3 && last(ownerApp, 'pool_dispatch'),
      'by the loop',
    )
    expect(third.dispatch).toMatchObject({ session: null, machine: machine.machineId, blob: 'sealed-done' })
    const lines = all(ownerApp, 'pool_audit').filter(m => m.entry.action === 'dispatch_set')
    expect(lines.map(m => m.entry.rev)).toEqual([1, 2, 3])
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => all(ownerApp, 'pool_snapshot').length === 2, 'a new snapshot')
    expect(last(ownerApp, 'pool_snapshot')?.pool.dispatch).toMatchObject({ rev: 3, blob: 'sealed-done' })
  })

  test('a machine leaves its pools when its member leaves or is kicked, or when it is revoked', async () => {
    const owner = await account()
    const member = await account(2)
    const id = await pool(owner)
    await enter(owner, member, id)
    const ownerApp = await connect('/ws/app', owner.token)
    const memberApp = await connect('/ws/app', member.token)
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => last(ownerApp, 'pool_snapshot'), 'the snapshot')
    const [kept, revoked] = member.machines
    const services = [await service(kept.token), await service(revoked.token)]
    addMachine(memberApp, id, kept.machineId)
    addMachine(memberApp, id, revoked.machineId)
    await eventually(() => services.every(s => last(s, 'pool_machine_join')), 'the orders')

    expect((await api(`/api/machines/${revoked.machineId}`, member.token, 'DELETE')).status).toBe(200)
    await eventually(() => last(services[1], 'pool_machine_leave'), 'the revoked machine told')
    await eventually(() => last(ownerApp, 'pool_machine_left')?.machine === revoked.machineId, 'the revoked machine gone')
    const removed = await eventually(() => all(ownerApp, 'pool_audit').find(m => m.entry.action === 'machine_removed'), 'the audit')
    expect(removed.entry.target).toEqual({ account: member.id, machine: revoked.machineId })

    expect((await api(`/api/pools/${id}/leave`, member.token, 'POST', {})).status).toBe(200)
    await eventually(() => last(services[0], 'pool_machine_leave'), 'the service told')
    ownerApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => all(ownerApp, 'pool_snapshot').length === 2, 'a new snapshot')
    expect(last(ownerApp, 'pool_snapshot')?.pool.machines).toEqual([])
    // Gone with its member: on reconnecting, the service gets no order.
    services[0].socket.close()
    const again = await service(kept.token)
    await Bun.sleep(150)
    expect(all(again, 'pool_machine_join')).toEqual([])
  })

  test('a machine is stopped by its owner or an admin: its worker sessions end, its orchestrator session goes on', async () => {
    const admin = await account(1)
    const member = await account(1)
    const other = await account(1)
    const id = await pool(admin)
    await enter(admin, member, id)
    await enter(admin, other, id)
    const adminApp = await connect('/ws/app', admin.token)
    const memberApp = await connect('/ws/app', member.token)
    const otherApp = await connect('/ws/app', other.token)
    adminApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => last(adminApp, 'pool_snapshot'), 'the snapshot')
    const [mine] = member.machines
    const [lead] = admin.machines
    const services = [await service(mine.token), await service(lead.token)]
    addMachine(memberApp, id, mine.machineId)
    addMachine(adminApp, id, lead.machineId)
    await eventually(() => services.every(s => last(s, 'pool_machine_join')), 'the orders')
    services[0].send({ t: 'pool_machine_ack', machineId: mine.machineId, poolId: id })
    services[1].send({ t: 'pool_machine_ack', machineId: lead.machineId, poolId: id })
    adminApp.send({ t: 'pool_orchestrator_machine', poolId: id, machine: { account: admin.id, machine: lead.machineId } })
    await eventually(() => last(adminApp, 'pool_orchestrator')?.machine, 'the orchestrator machine')

    // A worker session on the member's machine, and the orchestrator session on the admin's.
    const worker = await connect('/ws/agent', mine.token)
    worker.send({ t: 'hello', sessionId: 'ses_work', info: 'sealed-info', channel: true })
    const orchestrator = await connect('/ws/agent', lead.token)
    orchestrator.send({ t: 'hello', sessionId: 'ses_orch', info: 'sealed-info', channel: true })
    await Bun.sleep(100)
    const put = (svc: Client, machineId: string, sessionId: string, lead = false) =>
      svc.send({
        t: 'pool_machine_session',
        machineId,
        poolId: id,
        sessionId,
        order: 'o',
        profile: 'p',
        ...(lead ? { orchestrator: true } : {}),
      })
    put(services[0], mine.machineId, 'ses_work')
    put(services[1], lead.machineId, 'ses_orch', true)
    await eventually(() => last(adminApp, 'pool_orchestrator')?.orchestrator?.session === 'ses_orch', 'the orchestrator session')

    const stop = (app: Client, machine: string | null, stopped = true) => app.send({ t: 'pool_stop_machine', poolId: id, machine, stopped })
    // Another member's machine, or every machine, is not a member's to stop.
    stop(otherApp, mine.machineId)
    await eventually(() => last(otherApp, 'pool_error')?.message.includes('stop a machine'), 'not another member’s machine')
    stop(memberApp, null)
    await eventually(() => last(memberApp, 'pool_error')?.message.includes('every machine'), 'not every machine')

    // Its owner stops it: the worker session is interrupted and taken out; the machine shows stopped, in the audit too.
    stop(memberApp, mine.machineId)
    await eventually(() => last(worker, 'pool_stop'), 'the worker interrupted')
    await eventually(() => last(worker, 'pool_left'), 'the worker out')
    const shown = await eventually(
      () => all(adminApp, 'pool_machine').find(m => m.machine.machine === mine.machineId && m.machine.stopped),
      'stopped',
    )
    expect(shown.machine.stopped).toBe(true)
    const line = await eventually(() => all(adminApp, 'pool_audit').find(m => m.entry.action === 'machine_stopped'), 'the audit')
    expect(line.entry).toMatchObject({ account: member.id, target: { account: member.id, machine: mine.machineId } })

    // Started again, it works again.
    stop(memberApp, mine.machineId, false)
    await eventually(() => all(adminApp, 'pool_audit').some(m => m.entry.action === 'machine_started'), 'started again')
    expect(last(adminApp, 'pool_machine')?.machine.stopped).toBeUndefined()

    // The admin stops every machine: the orchestrator's own machine too, but its orchestrator session goes on.
    stop(adminApp, null)
    await eventually(() => all(adminApp, 'pool_audit').filter(m => m.entry.action === 'machine_stopped').length === 3, 'every machine')
    await Bun.sleep(100)
    expect(all(orchestrator, 'pool_stop')).toEqual([])
    adminApp.send({ t: 'pool_subscribe', poolId: id })
    await eventually(() => all(adminApp, 'pool_snapshot').length === 2, 'a new snapshot')
    const snapshot = last(adminApp, 'pool_snapshot')?.pool
    expect(snapshot?.machines?.map(m => m.stopped)).toEqual([true, true])
    expect(snapshot?.orchestrator).toEqual({ account: admin.id, session: 'ses_orch' })

    // Its owner can always take it out, stopped and in a paused pool.
    adminApp.send({ t: 'pool_pause', poolId: id, paused: true })
    await eventually(() => last(adminApp, 'pool_info')?.paused, 'paused')
    memberApp.send({ t: 'pool_remove_machine', poolId: id, machineId: mine.machineId })
    await eventually(() => last(adminApp, 'pool_machine_left')?.machine === mine.machineId, 'taken out')
  })
})
