import { runChannel } from './channel'
import { loadConfig, saveConfig, VERSION } from './config'
import { runHook } from './hook'
import { install, status, uninstall } from './install'
import { runOpenCode } from './opencode/bridge'
import { restartService } from './service/control'
import { runService } from './service/index'
import { runStatusLine } from './statusline'
import { useToken } from './token'

const USAGE = `Tonton Claude ${VERSION}

  tonton status              check the setup and the connection
  tonton token [token]       show the relay, or connect to the relay and account of a token from the app
  tonton tray on|off         show or hide the tray icon
  tonton install             update this machine (TONTON_TOKEN=<token> to connect it)
  tonton uninstall`

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case 'hook':
    await runHook()
    process.exit(0)
    break
  case 'channel':
    await runChannel()
    break
  case 'opencode':
    await runOpenCode()
    break
  case 'statusline':
    await runStatusLine()
    break
  case 'service':
    await runService(args)
    break
  case 'token':
    await token(args[0])
    break
  case 'tray':
    tray(args[0])
    break
  case 'install':
    await install(args)
    break
  case 'uninstall':
    await uninstall()
    break
  case 'status':
    await status()
    break
  case 'version':
  case '--version':
    console.log(VERSION)
    break
  default:
    console.log(USAGE)
}

async function token(input: string | undefined) {
  if (!input) {
    const config = loadConfig()
    console.log(config ? `Connected to ${config.server}` : 'Not set up. Copy the token from Tonton Claude › Machines on your Mac.')
    return
  }
  try {
    console.log(await useToken(input))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function tray(state: string | undefined) {
  const config = loadConfig()
  if (!config || (state !== 'on' && state !== 'off')) {
    console.log(config ? 'Usage: tonton tray on|off' : 'Not set up.')
    process.exit(1)
  }
  saveConfig({ ...config, tray: state === 'on' })
  // The tray icon belongs to the service, which reads the setting when it starts.
  restartService()
}
