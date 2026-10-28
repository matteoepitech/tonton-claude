// Compiles the agents and the relay into standalone executables in dist/ (no runtime needed where they run), with the
// version of the release inlined, and the web app into one HTML file.
// Usage: bun run build [--version 1.2.3] [name filter, e.g. windows, relay or web]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildWeb } from './build-web'
import { SITE_DEFINE, SITE_PLUGINS } from './site-build'

const targets = [
  ['agent/src/main.ts', 'bun-darwin-arm64', 'tonton-darwin-arm64'],
  ['agent/src/main.ts', 'bun-darwin-x64', 'tonton-darwin-x64'],
  ['agent/src/main.ts', 'bun-linux-x64', 'tonton-linux-x64'],
  ['agent/src/main.ts', 'bun-linux-arm64', 'tonton-linux-arm64'],
  ['agent/src/main.ts', 'bun-windows-x64', 'tonton-windows-x64.exe'],
  ['relay/src/main.ts', 'bun-linux-x64', 'tonton-relay-linux-x64'],
  ['relay/src/main.ts', 'bun-linux-arm64', 'tonton-relay-linux-arm64'],
] as const

const root = join(import.meta.dir, '..')
const args = process.argv.slice(2)
const versionIndex = args.indexOf('--version')
const version = versionIndex >= 0 ? args.splice(versionIndex, 2)[1] : (process.env.TONTON_VERSION ?? gitVersion())
const only = args[0]
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid version "${version}"`)

const out = join(root, 'dist')
mkdirSync(out, { recursive: true })
for (const [entry, target, name] of targets) {
  if (only && !name.includes(only)) continue
  // The relay carries its website, which needs Tailwind's plugin: the build API, not the command line.
  if (entry.startsWith('relay/')) {
    const built = await Bun.build({
      entrypoints: [join(root, entry)],
      compile: { target, outfile: join(out, name) },
      minify: true,
      define: { ...SITE_DEFINE, 'process.env.TONTON_VERSION': JSON.stringify(version) },
      plugins: SITE_PLUGINS,
    })
    if (!built.success) throw new Error(built.logs.map(String).join('\n'))
    continue
  }
  const define = `--define=process.env.TONTON_VERSION=${JSON.stringify(version)}`
  const build = Bun.spawnSync(
    ['bun', 'build', '--compile', '--minify', `--target=${target}`, define, entry, '--outfile', join(out, name)],
    {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
}
if (!only || 'tonton-web.html'.includes(only)) await buildWeb(join(out, 'tonton-web.html'))
console.log(`built ${version} in dist/`)

/** The latest release tag, for local builds. */
function gitVersion(): string {
  const tag = Bun.spawnSync(['git', 'describe', '--tags', '--abbrev=0'], { cwd: root, stderr: 'ignore' }).stdout.toString().trim()
  return tag.replace(/^v/, '') || '0.0.0'
}
