// Runs before every test file (bunfig.toml). The agent's paths come from TONTON_HOME when its modules load: tests that
// import agent code in their own process get a temporary home, so nothing they log or write lands in ~/.tonton. Tests
// that spawn an agent still pass their own TONTON_HOME.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TONTON_HOME ||= mkdtempSync(join(tmpdir(), 'tonton-test-home-'))
process.env.TONTON_SERVICE ||= 'off'
