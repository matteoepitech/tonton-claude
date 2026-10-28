// One HTML page with its script and style inline, from web/index.html. The Windows and Linux island (desktop/) builds its
// page with it, and scripts/build-web.ts the website's. Kept apart from the website's build, whose Tailwind plugin the
// island neither needs nor installs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(import.meta.dir, '..')

/** The page of web/index.html with `entry` bundled for browsers and `styles` one after the other, all inline. */
export async function buildPage(entry: string, styles: string[], out: string) {
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
  writePage(await result.outputs[0].text(), styles.map(file => readFileSync(file, 'utf8')).join('\n'), out)
}

export function writePage(script: string, style: string, out: string) {
  const page = readFileSync(join(root, 'web/index.html'), 'utf8')
    // Nothing in the script may close the inline tag early, nor the style its own.
    .replace('/* STYLE */', () => style.replaceAll('</style', '<\\/style'))
    .replace('/* SCRIPT */', () => script.replaceAll('</script', '<\\/script'))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, page)
}
