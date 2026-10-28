// Builds the web app (web/) into one HTML file with its script and style inline: open it from disk, or host it anywhere.
// The Windows and Linux island (desktop/) builds its page the same way, from its own script and the web app's style.
// Usage: bun scripts/build-web.ts [out file]   (the release puts it in dist/tonton-web.html)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/** The page of web/index.html with `entry` bundled for browsers and `styles` one after the other, all inline. */
export async function buildPage(entry: string, styles: string[], out: string) {
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
  writePage(await result.outputs[0].text(), styles.map(file => readFileSync(file, 'utf8')).join('\n'), out)
}

function writePage(script: string, style: string, out: string) {
  const page = readFileSync(join(root, 'web/index.html'), 'utf8')
    // Nothing in the script may close the inline tag early, nor the style its own.
    .replace('/* STYLE */', () => style.replaceAll('</style', '<\\/style'))
    .replace('/* SCRIPT */', () => script.replaceAll('</script', '<\\/script'))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, page)
}

if (import.meta.main) {
  const out = process.argv[2] ?? join(import.meta.dir, '../dist/tonton-web.html')
  await buildWeb(out)
  console.log(`built ${out}`)
}
