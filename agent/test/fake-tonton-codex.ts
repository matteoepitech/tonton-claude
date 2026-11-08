// `tonton codex` for launch tests: the real wrapper, on the fake codex and the test's run folder.
import { join } from 'node:path'
import { runCodex } from '../src/codex/wrapper'

const [run = ''] = process.argv.slice(2)
process.exit(await runCodex([], { run, codex: [process.execPath, join(import.meta.dir, 'fake-codex.ts')] }))
