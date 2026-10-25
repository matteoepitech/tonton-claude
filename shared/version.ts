// The version comes from the release tag: scripts/build.ts inlines it into the agent and the relay. Development builds
// report 0.0.0, which is never offered as an update.
export const VERSION = process.env.TONTON_VERSION || '0.0.0'

/** Where the app, the agents, the relay and the install scripts are published. Overridable for tests. */
export const RELEASES_URL = process.env.TONTON_RELEASES_URL || 'https://github.com/matteoepitech/tonton-claude/releases'

export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/

/** True when `a` is an older release than `b`. Versions are plain `major.minor.patch`. */
export function isOlder(a: string, b: string): boolean {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0)
  return false
}
