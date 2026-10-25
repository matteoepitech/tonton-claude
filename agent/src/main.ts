import { runChannel } from './channel'
import { loadConfig, saveConfig, VERSION } from './config'
import { runHook } from './hook'
import { install, status, uninstall } from './install'
import { restartService } from './service/control'
import { runService } from './service/index'
import { switchRelay } from './switch-relay'

const USAGE = `Tonton Claude ${VERSION}

  tonton status                     check the setup and the connection
  tonton relay [address | code]     show or change the relay (a code from the app joins another account)
  tonton tray on|off                show or hide the tray icon
  tonton install                    update this machine (TONTON_ENROLL=<code> to enroll it)
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
  case 'service':
    await runService(args)
    break
  case 'relay':
    await relay(args[0])
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

async function relay(input: string | undefined) {
  if (!input) {
    console.log(loadConfig()?.server ?? 'Not set up. Use the connection code from Tonton Claude › Machines › Add machine.')
    return
  }
  try {
    console.log(await switchRelay(input))
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
