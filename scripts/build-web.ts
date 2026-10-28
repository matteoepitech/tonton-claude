// Builds the web app (web/) into one HTML file with its script and style inline: open it from disk, or host it anywhere.
// Usage: bun scripts/build-web.ts [out file]   (the release puts it in dist/tonton-web.html)
import { join } from 'node:path'
import { writePage } from './build-page'
import { SITE_DEFINE, SITE_PLUGINS } from './site-build'

const root = join(import.meta.dir, '..')

/** The website (web/site.html), its script and its Tailwind stylesheet inline in one file. */
export async function buildWeb(out: string) {
  const result = await Bun.build({
    entrypoints: [join(root, 'web/site.html')],
    minify: true,
    define: SITE_DEFINE,
    plugins: SITE_PLUGINS,
  })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
  const script = result.outputs.find(output => output.path.endsWith('.js'))
  const style = result.outputs.find(output => output.path.endsWith('.css'))
  if (!script || !style) throw new Error('the website built without its script or its style')
  writePage(await script.text(), await style.text(), out)
}

if (import.meta.main) {
  const out = process.argv[2] ?? join(import.meta.dir, '../dist/tonton-web.html')
  await buildWeb(out)
  console.log(`built ${out}`)
}
