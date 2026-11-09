// `tonton codex` for launch tests: the real wrapper, on the fake codex and the test's run folder, with the arguments
// that follow it (`-m <model>` for a pool task).
import { join } from 'node:path'
import { runCodex } from '../src/codex/wrapper'

const [run = '', ...args] = process.argv.slice(2)
process.exit(await runCodex(args, { run, codex: [process.execPath, join(import.meta.dir, 'fake-codex.ts')] }))
