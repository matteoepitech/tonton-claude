import { runChannel } from './channel'
import { VERSION } from './config'
import { runHook } from './hook'
import { install, status, uninstall } from './install'

const USAGE = `Tonton Claude ${VERSION}

  TONTON_ENROLL=<code.key> tonton install --server <url> [--name <machine>]
  tonton status
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
