// Builds the web app (web/) into one HTML file with its script and style inline: open it from disk, or host it anywhere.
// The Windows and Linux island (desktop/) builds its page the same way, from its own script and the web app's style.
// Usage: bun scripts/build-web.ts [out file]   (the release puts it in dist/tonton-web.html)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(import.meta.dir, '..')

export function buildWeb(out: string) {
  return buildPage(join(root, 'web/app.ts'), [join(root, 'web/style.css')], out)
}

/** The page of web/index.html with `entry` bundled for browsers and `styles` one after the other, all inline. */
export async function buildPage(entry: string, styles: string[], out: string) {
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
  // Nothing in the script may close the inline tag early.
  const script = (await result.outputs[0].text()).replaceAll('</script', '<\\/script')
  const style = styles.map(file => readFileSync(file, 'utf8')).join('\n')
  const page = readFileSync(join(root, 'web/index.html'), 'utf8')
    .replace('/* STYLE */', () => style)
    .replace('/* SCRIPT */', () => script)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, page)
}

if (import.meta.main) {
  const out = process.argv[2] ?? join(import.meta.dir, '../dist/tonton-web.html')
  await buildWeb(out)
  console.log(`built ${out}`)
}
