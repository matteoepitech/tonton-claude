import type { Entry, ImageData } from '../../../shared/protocol'

// How many images the conversation keeps, for Claude Code's transcripts and OpenCode's events alike. Sealing adds a third
// to an image's base64, and the relay drops a sealed entry over 8 MB (MAX_BLOB_BYTES in relay/src/limits.ts) and keeps
// 16 MB of a session's history (MAX_SESSION_BYTES): images past these budgets are left out, and the entry says how many.

/** Larger images stay out of the conversation. */
export const MAX_IMAGE_BASE64 = 4 * 1024 * 1024
/** All the images of one entry: about 6.7 MB once sealed, under the relay's 8 MB with the entry's text. */
export const MAX_ENTRY_IMAGES_BASE64 = 5 * 1024 * 1024
/** On a (re)connection only the latest entries keep their images, the rest is sent as text. */
export const BACKLOG_IMAGES = 40
/** And only as many as fit in this, the newest first: about 13 MB sealed, inside the relay's 16 MB with room for the text. */
export const BACKLOG_IMAGES_BASE64 = 10 * 1024 * 1024

/** The text and images of a new entry: the images that fit in the budget of one entry, in order, and a note for the others. */
export function entryImages(text: string, images: ImageData[]): { text: string; images?: ImageData[] } {
  const { kept, dropped } = fit(images, MAX_ENTRY_IMAGES_BASE64)
  return { text: notLoaded(text, dropped), ...(kept.length ? { images: kept } : {}) }
}

/**
 * The backlog sent on a (re)connection: images on the latest entries only, kept from the newest within the budget. The
 * entries that lose theirs say how many they had.
 */
export function backlogImages(entries: Entry[], { latest = BACKLOG_IMAGES, budget = BACKLOG_IMAGES_BASE64 } = {}): Entry[] {
  let left = budget
  const backlog = [...entries]
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    const images = 'images' in entry ? (entry.images ?? []) : []
    const before = forgotten.get(entry) ?? 0
    if (!images.length && !before) continue
    const { kept, dropped } = index >= entries.length - latest ? fit(images, left) : { kept: [], dropped: images.length }
    left -= base64Length(kept)
    if (!dropped && !before) continue
    // Only the entries of these kinds have images.
    const { images: _images, ...rest } = entry as Extract<Entry, { kind: 'user' | 'tool_result' }>
    backlog[index] = { ...rest, text: notLoaded(rest.text, before + dropped), ...(kept.length ? { images: kept } : {}) } as Entry
  }
  return backlog
}

/** How many images an entry of a backlog had before `forgetOldImages` let them go. */
const forgotten = new WeakMap<Entry, number>()

/**
 * The backlog an agent keeps: past its latest entries, images are never sent again, so they are let go instead of staying
 * in memory with the 400 entries. Each entry remembers how many it had, for `backlogImages` to say so as before, and its
 * text stays as it was, for the last message of the meta.
 */
export function forgetOldImages(entries: Entry[], latest = BACKLOG_IMAGES): Entry[] {
  return entries.map((entry, index) => {
    if (index >= entries.length - latest || !('images' in entry) || !entry.images?.length) return entry
    const { images, ...rest } = entry
    const light = rest as Entry
    forgotten.set(light, images.length)
    return light
  })
}

/** The images that fit in `budget`, in order, each under the size of one image. */
function fit(images: ImageData[], budget: number): { kept: ImageData[]; dropped: number } {
  const kept: ImageData[] = []
  let left = budget
  for (const image of images) {
    if (image.data.length > MAX_IMAGE_BASE64 || image.data.length > left) continue
    kept.push(image)
    left -= image.data.length
  }
  return { kept, dropped: images.length - kept.length }
}

function notLoaded(text: string, count: number): string {
  if (!count) return text
  const note = `[${count} image${count === 1 ? '' : 's'} not loaded]`
  return text ? `${text}\n${note}` : note
}

const base64Length = (images: ImageData[]) => images.reduce((sum, image) => sum + image.data.length, 0)
