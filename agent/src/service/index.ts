import { RelayConnection } from '../channel/relay-connection'
import { loadConfig, VERSION } from '../config'
import { log } from '../log'
import { handleUpdateOrder } from '../update'
import { acquireLock, releaseLock } from './control'
import { writeStatus } from './status'
import { runTray } from './tray'

/** Picks up `tonton relay` changes. */
const CONFIG_POLL_MS = 2000

/**
 * Runs in the background from login: keeps the machine reachable so the app can update it even with no claude open,
 * and shows the tray icon where the relay can be changed. Sessions keep their own connection, through their channel.
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
  let current: string | null = null
  const follow = () => {
    const config = loadConfig()
    const identity = config ? `${config.server} ${config.token}` : ''
    if (identity === current) return
    current = identity
    connection?.stop()
    connection = null
    if (!config) {
      writeStatus('not-configured', null)
      return
    }
    log('service: connecting', { relay: config.server })
    writeStatus('connecting', config.server)
    const relay: RelayConnection = new RelayConnection(config, 'service', {
      connected: () => writeStatus('connected', config.server),
      disconnected: () => writeStatus('connecting', config.server),
      revoked: () => writeStatus('revoked', config.server),
      message: message => {
        if (message.t === 'update') void handleUpdateOrder(config, message.order, relay)
      },
    })
    connection = relay
    relay.connect()
  }
  follow()
  setInterval(follow, CONFIG_POLL_MS)
  runTray(stop)
}
