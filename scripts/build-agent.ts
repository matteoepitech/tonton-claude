// Cross-compiles the agent into standalone executables (no runtime needed on the target machines).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const targets = [
  ['bun-darwin-arm64', 'tonton-darwin-arm64'],
  ['bun-darwin-x64', 'tonton-darwin-x64'],
  ['bun-linux-x64', 'tonton-linux-x64'],
  ['bun-linux-arm64', 'tonton-linux-arm64'],
  ['bun-windows-x64', 'tonton-windows-x64.exe'],
] as const

const only = process.argv[2]
const out = join(import.meta.dir, '../dist')
mkdirSync(out, { recursive: true })

for (const [target, name] of targets) {
  if (only && !name.includes(only)) continue
  const proc = Bun.spawnSync(
    ['bun', 'build', '--compile', '--minify', `--target=${target}`, 'agent/src/main.ts', '--outfile', join(out, name)],
    {
      cwd: join(import.meta.dir, '..'),
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1)
}
