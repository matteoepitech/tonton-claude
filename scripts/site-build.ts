// How the website (web/site.html, React with Tailwind) is bundled, for the relay's executable (scripts/build.ts), for
// `bun run relay` (relay/src/site.ts) and for tonton-web.html (scripts/build-web.ts): React in its production build, and
// Tailwind's classes compiled into the stylesheet.
import type { BunPlugin } from 'bun'
import tailwind from 'bun-plugin-tailwind'

export const SITE_DEFINE = { 'process.env.NODE_ENV': '"production"' }
export const SITE_PLUGINS: BunPlugin[] = [tailwind]
