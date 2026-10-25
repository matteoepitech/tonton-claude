import { expect, test } from 'bun:test'
import { withoutConsole } from '../src/install/system'
import { launchAgentPlist, systemdUnit } from '../src/service/control'

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

test('Linux runs it as a user unit', () => {
  const unit = systemdUnit('/home/me/.tonton/bin/tonton', '/home/me/.tonton')
  expect(unit).toContain('ExecStart="/home/me/.tonton/bin/tonton" service')
  expect(unit).toContain('Restart=on-failure')
  expect(unit).toContain('WantedBy=default.target')
})
