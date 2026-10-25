// Version of the agent built from this tree. The relay serves these binaries and offers this version as the update,
// so bump it whenever the agent changes.
export const AGENT_VERSION = '0.4.0'

/** True when `a` is an older release than `b`. Versions are plain `major.minor.patch`. */
export function isOlder(a: string, b: string): boolean {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0)
  return false
}

export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
