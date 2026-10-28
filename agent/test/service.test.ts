import { expect, test } from 'bun:test'
import { withoutConsole } from '../src/install/system'
import { launchAgentPlist, systemdUnit } from '../src/service/control'
import { loginShell, searchPath, usualFolders } from '../src/service/search-path'

test('the windowless Windows copy only differs by its subsystem', () => {
  // A minimal PE: "MZ", the header offset at 0x3c, "PE\0\0", then the optional header.
  const exe = new Uint8Array(512)
  exe.set([0x4d, 0x5a])
  new DataView(exe.buffer).setUint32(0x3c, 0x80, true)
  exe.set([0x50, 0x45, 0, 0], 0x80)
  new DataView(exe.buffer).setUint16(0x80 + 24 + 68, 3, true)

  const windowless = withoutConsole(exe)
  expect(new DataView(windowless.buffer).getUint16(0x80 + 24 + 68, true)).toBe(2)
  expect(new DataView(exe.buffer).getUint16(0x80 + 24 + 68, true)).toBe(3)
  expect(windowless.filter((byte, i) => byte !== exe[i])).toHaveLength(1)
  expect(() => withoutConsole(new Uint8Array(512))).toThrow('not a Windows executable')
})

test('macOS restarts the service after a crash, not after Quit', () => {
  const plist = launchAgentPlist('/Users/me/.tonton/bin/tonton', '/Users/me/.tonton')
  expect(plist).toContain('<string>/Users/me/.tonton/bin/tonton</string><string>service</string>')
  expect(plist).toContain('<key>SuccessfulExit</key><false/>')
  expect(launchAgentPlist('/a&b/tonton', '/a&b')).toContain('/a&amp;b/tonton')
})

test("the service finds tmux and the coding tools where they are installed, not only in launchd's short PATH", () => {
  const exists = (folder: string) => ['/opt/homebrew/bin', '/usr/local/bin', '/Users/me/.local/bin'].includes(folder)
  const darwin = usualFolders('darwin', '/Users/me')
  expect(searchPath('/usr/bin:/bin:/usr/sbin:/sbin', darwin, exists)).toBe(
    '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin',
  )
  // What its owner set comes first, each folder once.
  expect(searchPath('/Users/me/.local/bin:/usr/bin', darwin, exists)).toBe('/Users/me/.local/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin')
  expect(searchPath('', usualFolders('linux', '/home/me'), folder => folder === '/usr/bin')).toBe('/usr/bin')
  expect(usualFolders('win32')).toEqual([])
  // Written in the LaunchAgent and the systemd unit, so every program the service starts finds them.
  expect(launchAgentPlist('/b', '/h', [], '/usr/bin:/opt/homebrew/bin')).toContain(
    '<key>PATH</key><string>/usr/bin:/opt/homebrew/bin</string>',
  )
  expect(systemdUnit('/b', '/h', [], '/usr/bin:/snap/bin')).toContain('Environment="PATH=/usr/bin:/snap/bin"')
})

test("sessions start in the user's login shell, which launchd does not give the service", () => {
  expect(loginShell(() => ({ shell: '/bin/zsh' }))).toBe('/bin/zsh')
  expect(loginShell(() => ({ shell: '/usr/sbin/nologin' }))).toBeNull()
  expect(loginShell(() => ({ shell: null }))).toBeNull()
  expect(
    loginShell(() => {
      throw new Error('no passwd entry')
    }),
  ).toBeNull()
})

test('Linux runs it as a user unit', () => {
  const unit = systemdUnit('/home/me/.tonton/bin/tonton', '/home/me/.tonton')
  expect(unit).toContain('ExecStart="/home/me/.tonton/bin/tonton" service')
  expect(unit).toContain('Restart=on-failure')
  expect(unit).toContain('WantedBy=default.target')
})
