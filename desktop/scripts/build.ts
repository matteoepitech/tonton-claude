// Builds the island into dist/, which electron-builder packages: the main process and the preload script bundled for
// Electron's Node (shared/ inlined, Electron itself left out), the page as one HTML file like the web app, and the icons.
// Usage: bun scripts/build.ts
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildPage } from '../../scripts/build-page'

const desktop = join(import.meta.dir, '..')
const root = join(desktop, '..')
const out = join(desktop, 'dist')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

for (const [entry, name] of [
  ['src/main/main.ts', 'main.cjs'],
  ['src/preload.ts', 'preload.cjs'],
] as const) {
  const result = await Bun.build({
    entrypoints: [join(desktop, entry)],
    outdir: out,
    naming: name,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
}

await buildPage(
  join(desktop, 'src/renderer/island.ts'),
  [join(root, 'web/style.css'), join(desktop, 'src/renderer/island.css')],
  join(out, 'island.html'),
)
copyFileSync(join(root, '.github/assets/icon.png'), join(out, 'icon.png'))
copyFileSync(join(root, 'agent/tray/windows/tonton.ico'), join(out, 'tray.ico'))
console.log(`built ${out}`)
