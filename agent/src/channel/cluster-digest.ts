// The cluster posts a Claude Code session gets at its next prompt (docs/cluster.md, Delivery): its channel writes each one
// to a file of its own, and the UserPromptSubmit hook, another process, takes them all and hands them to Claude as one
// digest. A file is taken by renaming it first, so two hooks never hand the same post twice.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../config'
import { log } from '../log'
import { clusterDigest } from './cluster-work'

/** Posts kept for one session: past that, the oldest go, and the digest says how many. */
export const DIGEST_SIZE = 30

let written = 0

const folderOf = (sessionId: string) => join(paths.run, 'cluster-digest', sessionId.replace(/[^\w-]/g, '_'))

/** Names sort in the order the posts came: time, then a counter, then the cluster. */
const isPost = (file: string) => /^\d{13}-\d{6}-[\w-]+\.txt$/.test(file)

/** Keeps a post for the session's next prompt. */
export function deferClusterPost(sessionId: string, clusterId: string, text: string) {
  const folder = folderOf(sessionId)
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    written = (written + 1) % 1_000_000
    const name = `${Date.now()}-${String(written).padStart(6, '0')}-${clusterId.replace(/[^\w-]/g, '_')}.txt`
    writeFileSync(join(folder, name), text, { mode: 0o600 })
    const files = readdirSync(folder).filter(isPost).sort()
    // The oldest go, with a mark the digest counts.
    for (const file of files.slice(0, Math.max(0, files.length - DIGEST_SIZE))) {
      renameSync(join(folder, file), join(folder, `${file}.dropped`))
    }
  } catch (error) {
    log('cluster post not kept for the next prompt', String(error))
  }
}

/** The session left a cluster: its posts that waited go. */
export function forgetClusterPosts(sessionId: string, clusterId: string) {
  const folder = folderOf(sessionId)
  const suffix = `-${clusterId.replace(/[^\w-]/g, '_')}.txt`
  try {
    for (const file of readdirSync(folder)) if (file.includes(suffix)) rmSync(join(folder, file), { force: true })
  } catch {}
}

/** Every post that waited for this prompt, as one text, or null when none did. Run by the UserPromptSubmit hook. */
export function takeClusterDigest(sessionId: string): string | null {
  const folder = folderOf(sessionId)
  let files: string[]
  try {
    files = readdirSync(folder).sort()
  } catch {
    return null
  }
  const posts: string[] = []
  let dropped = 0
  const tag = `.taken-${process.pid}`
  for (const file of files) {
    const path = join(folder, file)
    if (file.endsWith('.dropped')) {
      if (take(path, tag)) dropped++
      rmSync(path + tag, { force: true })
      continue
    }
    if (!isPost(file) || !take(path, tag)) continue
    try {
      posts.push(readFileSync(path + tag, 'utf8'))
    } catch {}
    rmSync(path + tag, { force: true })
  }
  return posts.length || dropped ? clusterDigest(posts, dropped) : null
}

function take(path: string, tag: string): boolean {
  try {
    renameSync(path, path + tag)
    return true
  } catch {
    return false
  }
}
