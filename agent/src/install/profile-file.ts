// Reads and writes the shell profiles that get the launcher, keeping the encoding each one has. Windows PowerShell 5.1
// saves with `>` and Out-File as UTF-16, and reads a file without a byte order mark in the ANSI code page: a PowerShell
// profile rewritten as plain UTF-8 breaks. zsh and bash profiles are read and written as UTF-8, as they always were.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Shell } from './shell-profile'

/** `ansi`: no byte order mark and not UTF-8, so in a code page that can't be known here: kept byte for byte. */
export type ProfileEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'ansi'

export interface ProfileText {
  text: string
  encoding: ProfileEncoding
}

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]
const UTF16BE_BOM = [0xfe, 0xff]

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)

/** UTF-16 text after its byte order mark. An odd last byte is a cut file: it is dropped. */
function utf16(bytes: Uint8Array, bigEndian: boolean): string {
  const data = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)))
  return (bigEndian ? data.swap16() : data).toString('utf16le')
}

export function decodeProfile(bytes: Uint8Array): ProfileText {
  if (startsWith(bytes, UTF8_BOM)) {
    return { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3)), encoding: 'utf8-bom' }
  }
  if (startsWith(bytes, UTF16LE_BOM)) return { text: utf16(bytes.subarray(2), false), encoding: 'utf16le' }
  if (startsWith(bytes, UTF16BE_BOM)) return { text: utf16(bytes.subarray(2), true), encoding: 'utf16be' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' }
  } catch {
    // One character per byte, so the user's lines go back unchanged. What the launcher adds is ASCII.
    return { text: Buffer.from(bytes).toString('latin1'), encoding: 'ansi' }
  }
}

export function encodeProfile({ text, encoding }: ProfileText): Uint8Array {
  switch (encoding) {
    case 'utf8':
      return Buffer.from(text, 'utf8')
    case 'utf8-bom':
      return Buffer.concat([Buffer.from(UTF8_BOM), Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from(UTF16LE_BOM), Buffer.from(text, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from(UTF16BE_BOM), Buffer.from(text, 'utf16le').swap16()])
    case 'ansi':
      return Buffer.from(text, 'latin1')
  }
}

/** Null when there is no profile yet. */
export function readProfile(file: string, shell: Shell): ProfileText | null {
  if (!existsSync(file)) return null
  const bytes = readFileSync(file)
  return shell === 'powershell' ? decodeProfile(bytes) : { text: bytes.toString('utf8'), encoding: 'utf8' }
}

/**
 * The encoding a profile gets with the launcher: the one it has, except that a new or plain UTF-8 PowerShell profile
 * gets a byte order mark, the one form that Windows PowerShell 5.1 and PowerShell 7 both read as UTF-8.
 */
export function launcherEncoding(shell: Shell, current: ProfileEncoding | null): ProfileEncoding {
  if (shell === 'powershell' && (current === null || current === 'utf8')) return 'utf8-bom'
  return current ?? 'utf8'
}

export function writeProfile(file: string, profile: ProfileText) {
  writeFileSync(file, encodeProfile(profile))
}
