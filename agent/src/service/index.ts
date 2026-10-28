import { seal } from '../../../shared/crypto'
import { parsePoolToMachine } from '../../../shared/pool-wire'
import { RelayConnection } from '../channel/relay-connection'
import { loadConfig, VERSION } from '../config'
import { receiveDiagnoseRequest } from '../diagnose'
import { handleStartAnswer, receiveStartOrder } from '../launch'
import { log } from '../log'
import { handleLogRequest } from '../logs'
import { receiveRules } from '../rules'
import { handleUpdateOrder } from '../update'
import { acquireLock, releaseLock } from './control'
import { cpuTimes, readHealth } from './health'
import { PoolLead } from './pool-lead'
import { DispatchLoop } from './pool-loop'
import { MachinePools } from './pool-machines'
import { PoolWorker } from './pool-worker'
import { writeStatus } from './status'
import { runTray } from './tray'

/** Picks up `tonton relay` changes. */
const CONFIG_POLL_MS = 2000
/** How often the machine's CPU, memory and battery go to the app. */
const HEALTH_INTERVAL_MS = 60_000

/**
 * Runs in the background from login: keeps the machine reachable so the app can update it even with no claude open,
 * and shows the tray icon where the relay can be changed. Sessions keep their own connection, through their channel.
 * When the machine is in a pool, it starts the sessions for the tasks dispatched to it (docs/pool-autopilot.md).
 */
export async function runService(args: string[]) {
  if (!acquireLock(args.includes('--replace'))) {
    log('service: already running')
    return
  }
  log('service started', { version: VERSION })
  const stop = () => {
    releaseLock()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  let connection: RelayConnection | null = null
  /** What the machine does for its pools: workers, the orchestrator session and the control loop on the orchestrator's. */
  let autopilot: { stop(): void }[] = []
  let current: string | null = null
  const follow = () => {
    const config = loadConfig()
    const identity = config ? `${config.server} ${config.token}` : ''
    if (identity === current) return
    current = identity
    connection?.stop()
    connection = null
    // The sessions it runs for pools keep running: the new ones find them again in their slots.
    for (const part of autopilot) part.stop()
    autopilot = []
    if (!config) {
      writeStatus('not-configured', null)
      return
    }
    log('service: connecting', { relay: config.server })
    writeStatus('connecting', config.server)
    const pools = new MachinePools(
      config.key,
      config.machineId,
      build => relay.post(build),
      poolId => {
        worker.changed(poolId)
        lead.changed(poolId)
        loop.changed(poolId)
      },
    )
    const worker = new PoolWorker(pools, { machineName: config.machine })
    const lead = new PoolLead(pools, { machineName: config.machine })
    const loop = new DispatchLoop(pools)
    autopilot = [worker, lead, loop]
    const relay: RelayConnection = new RelayConnection(config, 'service', {
      connected: () => {
        writeStatus('connected', config.server)
        reportHealth()
      },
      disconnected: () => writeStatus('connecting', config.server),
      revoked: () => writeStatus('revoked', config.server),
      message: message => {
        if (message.t === 'update') void handleUpdateOrder(config, message.order, relay)
        else if (message.t === 'rules') void receiveRules(config.key, message.rules)
        else if (message.t === 'start_session') receiveStartOrder(config, message.launchId, message.order, relay)
        else if (message.t === 'start_answer') void handleStartAnswer(config, message.launchId, message.answer)
        else if (message.t === 'agent_logs') void handleLogRequest(config, message.requestId, message.request, relay)
        else if (message.t === 'diagnose') void receiveDiagnoseRequest(config, message.requestId, message.request, relay, 'service')
        else if (message.t === 'pool_machine_join' || message.t === 'pool_machine_leave') {
          const order = parsePoolToMachine(message)
          if (order?.machineId !== config.machineId) return
          if (order.t === 'pool_machine_join') pools.receive(order.poolId, order.order)
          else pools.remove(order.poolId)
        }
      },
      pool: update => pools.apply(update),
    })
    connection = relay
    relay.connect()
  }
  // Sealed with the account key: the relay only passes the numbers on.
  let cpuSample = cpuTimes()
  const reportHealth = () => {
    const current = connection
    const config = loadConfig()
    if (!current || !config) return
    const { health, sample } = readHealth(cpuSample)
    cpuSample = sample
    current.post(async () => ({ t: 'health', health: await seal(config.key, health) }))
  }

  follow()
  setInterval(follow, CONFIG_POLL_MS)
  setInterval(reportHealth, HEALTH_INTERVAL_MS)
  runTray(stop)
}
