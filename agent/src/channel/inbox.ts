// Images and files from the notch, written to the inbox, so the session reads them by path.

import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { PromptPayload } from '../../../shared/protocol'
import { paths } from '../config'

export interface InboxFile {
  path: string
  /** An image, which Codex takes as one rather than as a path to read. */
  image: boolean
}

export function saveToInbox(files: PromptPayload['images'], inbox = paths.inbox): InboxFile[] {
  if (!files.length) return []
  mkdirSync(inbox, { recursive: true, mode: 0o700 })
  return files.map((file, index) => {
    const extension = file.mediaType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
    const name = basename(file.name || 'image').replace(/[^\w.-]/g, '_')
    const path = join(inbox, `${Date.now()}-${index}-${name}${/\.\w+$/.test(name) ? '' : `.${extension}`}`)
    writeFileSync(path, Buffer.from(file.data, 'base64'), { mode: 0o600 })
    return { path, image: file.mediaType.startsWith('image/') }
  })
}
