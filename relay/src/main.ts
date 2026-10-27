import { VERSION } from '../../shared/version'
import { loadConfig, type RelayConfig } from './config'
import { RelayContext, type RelayOptions } from './context'
import type { SocketData } from './hub'
import { createFetchHandler } from './routes'
import { createWebSocketHandler } from './sockets'

export function startRelay(config: RelayConfig, options: RelayOptions = {}) {
  const ctx = new RelayContext(config, options)
  const server = Bun.serve<SocketData>({
    port: config.port,
    idleTimeout: 120,
    fetch: createFetchHandler(ctx),
    websocket: createWebSocketHandler(ctx),
  })
  return {
    server,
    stop() {
      server.stop(true)
      ctx.dispose()
    },
  }
}

if (import.meta.main) {
  const config = loadConfig()
  const { server } = startRelay(config)
  const push = config.apns ? `, iPhone pushes for ${config.apns.topic}` : ''
  console.log(`Tonton Claude relay ${VERSION} listening on :${server.port} (registration ${config.registration}${push})`)
}
