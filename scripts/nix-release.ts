// Points the Nix flake at a release: its version and the SHA-256 of each executable the flake installs, read from the
// release's SHA256SUMS. Run after each release (`bun scripts/nix-release.ts 0.9.3`, or no version for the latest), then
// commit nix/release.json.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'matteoepitech/tonton-claude'
/** What the flake fetches: the agent for each system, the relay for Linux. */
const ASSETS = [
  'tonton-linux-x64',
  'tonton-linux-arm64',
  'tonton-darwin-x64',
  'tonton-darwin-arm64',
  'tonton-relay-linux-x64',
  'tonton-relay-linux-arm64',
]

async function latest(): Promise<string> {
  const response = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: 'manual' })
  const tag = /\/tag\/v([^/]+)$/.exec(response.headers.get('location') ?? '')?.[1]
  if (!tag) throw new Error('Could not find the latest release.')
  return tag
}

const version = process.argv[2]?.replace(/^v/, '') || (await latest())
const sums = await fetch(`https://github.com/${REPO}/releases/download/v${version}/SHA256SUMS`)
if (!sums.ok) throw new Error(`No SHA256SUMS for ${version}: ${sums.status}`)
const lines = (await sums.text()).split('\n')
const sha256: Record<string, string> = {}
for (const asset of ASSETS) {
  const hash = lines.find(line => line.endsWith(`  ${asset}`))?.split(' ')[0]
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${asset} is not in the SHA256SUMS of ${version}.`)
  sha256[asset] = hash
}
const file = join(import.meta.dir, '../nix/release.json')
writeFileSync(file, `${JSON.stringify({ version, sha256 }, null, 2)}\n`)
console.log(`nix/release.json now points at ${version}.`)
