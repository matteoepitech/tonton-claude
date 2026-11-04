// The island's main process, without Electron: where the window goes, the menu, the token on the relay socket, and the
// account kept in the keyring.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecoveredAccount } from '../../shared/recovery-key'
import { AccountStore, type Keyring } from '../src/main/account-store'
import { islandBounds } from '../src/main/geometry'
import { type MenuActions, menuTemplate } from '../src/main/menu'
import { socketHeaders } from '../src/main/relay-auth'
import { nextStep } from '../src/main/visibility'

const dir = mkdtempSync(join(tmpdir(), 'tonton-island-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const account: RecoveredAccount = {
  relay: 'https://tonton.d3l.tech',
  accountId: 'acct12345678',
  token: 'ta_AbCdEf0123456789',
  key: 'oze6LbNXeSIiEnjwELgj6N2Olugn0lb5OgUZxBTVJns',
}

describe('the window', () => {
  test('hangs centered from the top of the work area, under a top bar', () => {
    expect(islandBounds({ x: 0, y: 0, width: 1920, height: 1040 }, 'collapsed')).toEqual({ x: 770, y: 0, width: 380, height: 40 })
    // GNOME's top bar takes the first 32 pixels; a second screen on the left starts at a negative x.
    expect(islandBounds({ x: -1280, y: 32, width: 1280, height: 992 }, 'expanded')).toEqual({ x: -910, y: 32, width: 540, height: 660 })
  })

  test('fits small screens', () => {
    expect(islandBounds({ x: 0, y: 0, width: 400, height: 500 }, 'expanded')).toEqual({ x: 12, y: 0, width: 376, height: 488 })
  })
})

describe('showing the island', () => {
  test('hidden, the tray icon, the menu and opening the app again all show it open', () => {
    for (const trigger of ['tray', 'menu', 'launch'] as const) {
      expect(nextStep(trigger, false, 'collapsed')).toBe('show')
      expect(nextStep(trigger, false, 'expanded')).toBe('show')
    }
  })

  test('with its bar showing, the tray icon and opening the app again open it: only the menu hides it', () => {
    expect(nextStep('tray', true, 'collapsed')).toBe('expand')
    expect(nextStep('launch', true, 'collapsed')).toBe('expand')
    expect(nextStep('menu', true, 'collapsed')).toBe('hide')
  })

  test('open, the tray icon closes it to its bar, and opening the app again brings it forward', () => {
    expect(nextStep('tray', true, 'expanded')).toBe('collapse')
    expect(nextStep('launch', true, 'expanded')).toBe('focus')
    expect(nextStep('menu', true, 'expanded')).toBe('hide')
  })
})

describe('the relay socket', () => {
  const headers = { 'User-Agent': 'Chrome' }

  test('gets the bearer token in its handshake, and only the account relay socket does', () => {
    expect(socketHeaders('wss://tonton.d3l.tech/ws/app', account, headers)).toEqual({
      cancel: false,
      requestHeaders: { 'User-Agent': 'Chrome', Authorization: 'Bearer ta_AbCdEf0123456789' },
    })
    expect(socketHeaders('wss://TONTON.d3l.tech:443/ws/app', account, headers).cancel).toBe(false)
  })

  test('any other socket is refused, and every socket once signed out', () => {
    expect(socketHeaders('wss://evil.example/ws/app', account, headers)).toEqual({ cancel: true })
    expect(socketHeaders('wss://tonton.d3l.tech/ws/share', account, headers)).toEqual({ cancel: true })
    expect(socketHeaders('ws://tonton.d3l.tech/ws/app', account, headers)).toEqual({ cancel: true })
    expect(socketHeaders('wss://tonton.d3l.tech/ws/app', null, headers)).toEqual({ cancel: true })
    expect(socketHeaders('not a url', account, headers)).toEqual({ cancel: true })
  })
})

describe('the menu', () => {
  const calls: string[] = []
  const actions: MenuActions = {
    toggle: () => calls.push('toggle'),
    copyInstallCommand: platform => calls.push(`install ${platform}`),
    copyRecoveryKey: () => calls.push('recovery'),
    setOpenAtLogin: enabled => calls.push(`login ${enabled}`),
    signOut: () => calls.push('sign out'),
    quit: () => calls.push('quit'),
  }
  const labels = (items: ReturnType<typeof menuTemplate>) => items.map(item => item.label ?? item.type)

  test('signed in, it adds machines, copies the recovery key and signs out', () => {
    const items = menuTemplate({ signedIn: true, visible: true, openAtLogin: false }, actions)
    expect(labels(items)).toEqual([
      'Hide the island',
      'separator',
      'Add a machine',
      'Copy the recovery key',
      'separator',
      'Start at login',
      'Sign out',
      'separator',
      'Quit Tonton Claude',
    ])
    const submenu = items[2].submenu
    if (!Array.isArray(submenu)) throw new Error('no submenu')
    for (const item of submenu) item.click?.({} as never, undefined, {} as never)
    items.find(item => item.label === 'Start at login')?.click?.({ checked: true } as never, undefined, {} as never)
    expect(calls).toEqual(['install windows', 'install unix', 'login true'])
  })

  test('signed out, or where it cannot start at login, it says less', () => {
    expect(labels(menuTemplate({ signedIn: false, visible: false, openAtLogin: null }, actions))).toEqual([
      'Show the island',
      'separator',
      'Quit Tonton Claude',
    ])
  })
})

describe('the account', () => {
  // Stands in for safeStorage: the file must never hold the key in clear.
  const keyring = (available = true): Keyring => ({
    available: () => available,
    encrypt: text => Buffer.from(`sealed:${Buffer.from(text).toString('base64')}`),
    decrypt: data => {
      const text = data.toString()
      if (!text.startsWith('sealed:')) throw new Error('not ours')
      return Buffer.from(text.slice(7), 'base64').toString()
    },
  })

  test('is kept encrypted by the keyring, and forgotten', () => {
    const file = join(dir, 'kept', 'account')
    const store = new AccountStore(file, keyring())
    expect(store.load()).toBeNull()
    expect(store.save({ ...account, joinSecret: 'S3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS' })).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain(account.token)
    expect(new AccountStore(file, keyring()).load()).toEqual({ ...account, joinSecret: 'S3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS' })
    store.forget()
    expect(existsSync(file)).toBe(false)
  })

  test('is not written without a keyring', () => {
    const file = join(dir, 'none', 'account')
    const store = new AccountStore(file, keyring(false))
    expect(store.canRemember).toBe(false)
    expect(store.save(account)).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  const failing = (code: string, times: number) => {
    const tries: string[] = []
    const rename = (from: string, to: string) => {
      tries.push(code)
      if (tries.length <= times) throw Object.assign(new Error(`${code}: rename`), { code })
      renameSync(from, to)
    }
    return { tries, rename }
  }
  const other: RecoveredAccount = { ...account, accountId: 'acct87654321', token: 'ta_ZyXwVu9876543210' }

  test('is moved in place once Windows lets go of the file', () => {
    const file = join(dir, 'busy', 'account')
    const { tries, rename } = failing('EBUSY', 2)
    expect(new AccountStore(file, keyring(), rename).save(account)).toBe(true)
    expect(tries).toHaveLength(3)
    expect(new AccountStore(file, keyring()).load()).toEqual(account)
    expect(existsSync(`${file}.next`)).toBe(false)
  })

  test('that cannot be saved leaves the account saved before, and tries a few times only', () => {
    const file = join(dir, 'locked', 'account')
    expect(new AccountStore(file, keyring()).save(account)).toBe(true)
    const { tries, rename } = failing('EPERM', Number.POSITIVE_INFINITY)
    const store = new AccountStore(file, keyring(), rename)
    expect(store.keep(other, true)).toBe(false)
    expect(tries).toHaveLength(5)
    expect(store.load()).toEqual(account)
    expect(existsSync(`${file}.next`)).toBe(false)
    // Not a file in use: no point in trying again.
    const full = failing('ENOSPC', Number.POSITIVE_INFINITY)
    expect(new AccountStore(file, keyring(), full.rename).save(other)).toBe(false)
    expect(full.tries).toHaveLength(1)
  })

  test('not remembered, the account saved before is forgotten', () => {
    const file = join(dir, 'unticked', 'account')
    const store = new AccountStore(file, keyring())
    expect(store.keep(account, true)).toBe(true)
    expect(store.keep(other, false)).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(store.load()).toBeNull()
  })

  test('that no longer opens is removed', () => {
    const file = join(dir, 'damaged')
    writeFileSync(file, 'garbage')
    expect(new AccountStore(file, keyring()).load()).toBeNull()
    expect(existsSync(file)).toBe(false)
  })
})
