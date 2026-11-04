// Shell profiles on Windows: where PowerShell says its profile is, and the launcher written in an encoding Windows
// PowerShell 5.1 reads, without breaking a profile its own tools saved as UTF-16. On a temporary home, never the
// developer's own profiles.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeProfile, encodeProfile, readProfile } from '../src/install/profile-file'
import { removeLaunchers, type Setup, writeLaunchers } from '../src/install/setup'
import { BEGIN, launcherBlock, powershellString } from '../src/install/shell-profile'
import { decodeProfilePath, profilePathCommand } from '../src/install/system'

const dir = mkdtempSync(join(tmpdir(), 'tonton-profile-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const USER_LINES = "Set-Alias ll Get-ChildItem\r\n# Réglages de Jérôme, 日本語\r\n$env:EDITOR = 'code'\r\n"
const SETTINGS = 'C:\\Users\\Jérôme\\.tonton\\claude-settings.json'

describe('the PowerShell profile path', () => {
  // What [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(…)) prints, followed by PowerShell's line break.
  const printed = (path: string) => `${Buffer.from(path, 'utf8').toString('base64')}\r\n`

  test('comes back whole whatever the console code page, accents and spaces included', () => {
    for (const path of [
      'C:\\Users\\Jérôme\\Documents\\WindowsPowerShell\\profile.ps1',
      'C:\\Users\\jean\\OneDrive - Société\\Documents\\PowerShell\\profile.ps1',
      'C:\\Users\\Đorđe Šćepanović\\Documents\\PowerShell\\profile.ps1',
    ])
      expect(decodeProfilePath(printed(path))).toBe(path)
  })

  test('is printed as Base64, which no code page changes', () => {
    const command = profilePathCommand('powershell')
    expect(command.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
    expect(command[4]).toContain('$PROFILE.CurrentUserAllHosts')
    expect(command[4]).toContain('[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(')
  })

  test('nothing, or anything else, is no path', () => {
    expect(decodeProfilePath('')).toBeNull()
    expect(decodeProfilePath('\r\n')).toBeNull()
    expect(decodeProfilePath('C:\\Users\\J\u00a2r\u00a2me\\Documents\\WindowsPowerShell\\profile.ps1\r\n')).toBeNull()
  })
})

describe('profile encodings', () => {
  test('each one reads back as it was written', () => {
    for (const encoding of ['utf8', 'utf8-bom', 'utf16le', 'utf16be'] as const) {
      const bytes = encodeProfile({ text: USER_LINES, encoding })
      expect(decodeProfile(bytes)).toEqual({ text: USER_LINES, encoding })
    }
    expect([...encodeProfile({ text: 'a', encoding: 'utf16le' })]).toEqual([0xff, 0xfe, 0x61, 0x00])
    expect([...encodeProfile({ text: 'a', encoding: 'utf16be' })]).toEqual([0xfe, 0xff, 0x00, 0x61])
    expect([...encodeProfile({ text: 'a', encoding: 'utf8-bom' })]).toEqual([0xef, 0xbb, 0xbf, 0x61])
  })

  test('a file in a code page is kept byte for byte', () => {
    // "# Réglages" in Windows-1252, as Add-Content writes it in Windows PowerShell 5.1.
    const bytes = Uint8Array.from([0x23, 0x20, 0x52, 0xe9, 0x67, 0x6c, 0x61, 0x67, 0x65, 0x73, 0x0d, 0x0a])
    const profile = decodeProfile(bytes)
    expect(profile.encoding).toBe('ansi')
    expect([...encodeProfile(profile)]).toEqual([...bytes])
  })
})

describe('the PowerShell launcher', () => {
  test('names the settings in ASCII, so every encoding reads the same path', () => {
    expect(powershellString('C:\\Users\\jean\\.tonton\\s.json')).toBe("'C:\\Users\\jean\\.tonton\\s.json'")
    expect(powershellString(SETTINGS)).toBe('"C:\\Users\\J$([char]0x00E9)r$([char]0x00F4)me\\.tonton\\claude-settings.json"')
    // PowerShell would expand $ and ` inside double quotes, and read “ as a quote.
    expect(powershellString('D:\\a$b`c"d“é\\s.json')).toBe('"D:\\a`$b``c`"d$([char]0x201C)$([char]0x00E9)\\s.json"')
    expect(launcherBlock('powershell', SETTINGS)).toMatch(/^[\t\n -~]*$/)
  })
})

describe('writing the launcher', () => {
  let home: string
  let count = 0
  const setup = (file: string, shell: 'posix' | 'powershell'): Setup => ({
    binary: join(home, '.tonton', 'bin', 'tonton.exe'),
    home,
    claudeSettings: join(home, '.claude', 'settings.json'),
    claudeState: join(home, '.claude.json'),
    launcherSettings: SETTINGS,
    run: join(home, '.tonton', 'run'),
    profiles: [{ file, shell }],
    openCode: join(home, '.config', 'opencode'),
  })
  const noReplacement = (bytes: Buffer) => expect(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false)

  beforeEach(() => {
    home = join(dir, `home-${++count}`)
    mkdirSync(join(home, 'Documents', 'WindowsPowerShell'), { recursive: true })
  })

  test('a UTF-16 profile stays UTF-16 with the user lines, and the uninstall leaves it so', () => {
    const file = join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1')
    const original = encodeProfile({ text: USER_LINES, encoding: 'utf16le' })
    writeFileSync(file, original)
    writeLaunchers(setup(file, 'powershell'))
    const written = readFileSync(file)
    expect([...written.subarray(0, 2)]).toEqual([0xff, 0xfe])
    noReplacement(written)
    const profile = decodeProfile(written)
    expect(profile.encoding).toBe('utf16le')
    expect(profile.text.startsWith(USER_LINES.trimEnd())).toBe(true)
    expect(profile.text).toContain(launcherBlock('powershell', SETTINGS))

    removeLaunchers(setup(file, 'powershell').profiles)
    const removed = decodeProfile(readFileSync(file))
    expect(removed.encoding).toBe('utf16le')
    expect(removed.text.trim()).toBe(USER_LINES.trim())
    expect(removed.text).not.toContain(BEGIN)
  })

  test('a UTF-8 profile with a byte order mark keeps one, and only one', () => {
    const file = join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1')
    writeFileSync(file, encodeProfile({ text: USER_LINES, encoding: 'utf8-bom' }))
    writeLaunchers(setup(file, 'powershell'))
    writeLaunchers(setup(file, 'powershell'))
    const written = readFileSync(file)
    expect([...written.subarray(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 0x53])
    expect(readProfile(file, 'powershell')).toEqual({
      text: `${USER_LINES.trimEnd()}\n\n${launcherBlock('powershell', SETTINGS)}\n`,
      encoding: 'utf8-bom',
    })
  })

  test('a new or plain UTF-8 PowerShell profile gets a byte order mark, which Windows PowerShell 5.1 needs', () => {
    const fresh = join(home, 'Documents', 'PowerShell', 'profile.ps1')
    writeLaunchers(setup(fresh, 'powershell'))
    expect(readProfile(fresh, 'powershell')?.encoding).toBe('utf8-bom')
    expect(existsSync(`${fresh}.tonton-backup`)).toBe(false)

    const plain = join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1')
    writeFileSync(plain, USER_LINES)
    writeLaunchers(setup(plain, 'powershell'))
    expect(readProfile(plain, 'powershell')?.encoding).toBe('utf8-bom')
    expect(readProfile(plain, 'powershell')?.text.startsWith(USER_LINES.trimEnd())).toBe(true)
  })

  test('a profile in a code page keeps the user bytes as they were', () => {
    const file = join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1')
    const original = Buffer.from('# R\xe9glages\r\nSet-Alias ll Get-ChildItem\r\n', 'latin1')
    writeFileSync(file, original)
    writeLaunchers(setup(file, 'powershell'))
    const written = readFileSync(file)
    expect(written.subarray(0, original.length - 2).equals(original.subarray(0, original.length - 2))).toBe(true)
    expect(written.toString('latin1')).toContain(launcherBlock('powershell', SETTINGS))
  })

  test('the PowerShell profile is copied once, before the first change', () => {
    const file = join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1')
    const original = encodeProfile({ text: USER_LINES, encoding: 'utf16le' })
    writeFileSync(file, original)
    writeLaunchers(setup(file, 'powershell'))
    writeLaunchers({ ...setup(file, 'powershell'), launcherSettings: 'C:\\other.json' })
    expect(readFileSync(`${file}.tonton-backup`).equals(original)).toBe(true)
  })

  test('zsh and bash profiles stay plain UTF-8, without a copy', () => {
    const file = join(home, '.zshrc')
    writeFileSync(file, 'export NAME="Jérôme"\n')
    writeLaunchers({ ...setup(file, 'posix'), launcherSettings: '/home/jérôme/.tonton/claude-settings.json' })
    const written = readFileSync(file)
    expect(written[0]).toBe(0x65)
    expect(written.toString('utf8')).toContain("[ -f '/home/jérôme/.tonton/claude-settings.json' ]")
    expect(existsSync(`${file}.tonton-backup`)).toBe(false)
    removeLaunchers([{ file, shell: 'posix' }])
    expect(readFileSync(file, 'utf8').trim()).toBe('export NAME="Jérôme"')
  })
})
