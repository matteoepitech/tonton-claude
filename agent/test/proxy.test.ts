import { describe, expect, test } from 'bun:test'
import { bypassesProxy, proxyEnvironment, proxyFor, shownProxy } from '../src/proxy'
import { launchAgentPlist, systemdUnit } from '../src/service/control'

const RELAY = 'https://relay.example.com'
const PROXY = 'http://proxy.corp:3128'

describe('the proxy for the relay', () => {
  test('https and wss go through HTTPS_PROXY, http and ws through HTTP_PROXY, ALL_PROXY for both', () => {
    expect(proxyFor(RELAY, { HTTPS_PROXY: PROXY })).toEqual({ url: PROXY, from: 'HTTPS_PROXY' })
    expect(proxyFor('wss://relay.example.com/ws/agent', { https_proxy: PROXY })).toEqual({ url: PROXY, from: 'https_proxy' })
    expect(proxyFor(RELAY, { HTTP_PROXY: PROXY })).toBeNull()
    expect(proxyFor('ws://relay.example.com/ws/agent', { HTTP_PROXY: PROXY })).toEqual({ url: PROXY, from: 'HTTP_PROXY' })
    expect(proxyFor('http://relay.example.com', { HTTPS_PROXY: PROXY })).toBeNull()
    expect(proxyFor(RELAY, { ALL_PROXY: PROXY })).toEqual({ url: PROXY, from: 'ALL_PROXY' })
    expect(proxyFor(RELAY, {})).toBeNull()
  })

  test('lower case wins and empty values are skipped, like fetch does', () => {
    expect(proxyFor(RELAY, { https_proxy: PROXY, HTTPS_PROXY: 'http://other:1' })?.from).toBe('https_proxy')
    expect(proxyFor(RELAY, { https_proxy: ' ', HTTPS_PROXY: PROXY })?.from).toBe('HTTPS_PROXY')
    expect(proxyFor(RELAY, { HTTPS_PROXY: PROXY, ALL_PROXY: 'http://other:1' })?.from).toBe('HTTPS_PROXY')
    expect(proxyFor(RELAY, { all_proxy: PROXY, ALL_PROXY: 'http://other:1' })?.from).toBe('all_proxy')
  })

  test('an address without a scheme is an HTTP proxy; kinds the WebSocket client cannot use are left out', () => {
    expect(proxyFor(RELAY, { HTTPS_PROXY: 'proxy.corp:3128' })?.url).toBe(PROXY)
    expect(proxyFor(RELAY, { HTTPS_PROXY: 'https://proxy.corp:443' })?.url).toBe('https://proxy.corp:443')
    expect(proxyFor(RELAY, { HTTPS_PROXY: 'socks5://proxy.corp:1080' })).toBeNull()
    expect(proxyFor('not a url', { HTTPS_PROXY: PROXY })).toBeNull()
  })

  test('NO_PROXY, or no_proxy before it, sends the relay direct', () => {
    expect(proxyFor(RELAY, { HTTPS_PROXY: PROXY, NO_PROXY: 'relay.example.com' })).toBeNull()
    expect(proxyFor(RELAY, { HTTPS_PROXY: PROXY, no_proxy: 'other.org', NO_PROXY: 'relay.example.com' })).not.toBeNull()
    expect(proxyFor(RELAY, { HTTPS_PROXY: PROXY, no_proxy: '', NO_PROXY: 'relay.example.com' })).toBeNull()
  })
})

describe('NO_PROXY', () => {
  const bypasses = (url: string, list: string) => bypassesProxy(new URL(url), list)

  test('a domain covers its subdomains, however it is written', () => {
    for (const entry of ['relay.example.com', 'example.com', '.example.com', '*.example.com', 'EXAMPLE.com', 'example.com.'])
      expect(bypasses(RELAY, entry)).toBe(true)
    expect(bypasses(RELAY, 'ample.com')).toBe(false)
    expect(bypasses(RELAY, 'relay.example.com.evil')).toBe(false)
  })

  test('lists, stars, ports and IPv4 ranges', () => {
    expect(bypasses(RELAY, 'foo.org, relay.example.com')).toBe(true)
    expect(bypasses(RELAY, '*')).toBe(true)
    expect(bypasses(RELAY, '')).toBe(false)
    expect(bypasses('https://relay.example.com:8443', 'relay.example.com:8443')).toBe(true)
    expect(bypasses('https://relay.example.com:8443', 'relay.example.com:9999')).toBe(false)
    expect(bypasses('https://relay.example.com', 'relay.example.com:443')).toBe(true)
    expect(bypasses('https://relay.example.com:8443', 'relay.example.com')).toBe(true)
    expect(bypasses('http://10.1.2.3', '10.0.0.0/8')).toBe(true)
    expect(bypasses('http://10.1.2.3', '192.168.0.0/16')).toBe(false)
    expect(bypasses('http://10.1.2.3', '10.1.2.3')).toBe(true)
    expect(bypasses('http://[::1]:7777', '::1')).toBe(true)
    expect(bypasses('http://[::1]:7777', '[::1]:7777')).toBe(true)
  })
})

test('the password of a proxy never shows', () => {
  expect(shownProxy('http://jane:s3cr%40t@proxy.corp:3128')).toBe(PROXY)
  expect(shownProxy('%')).not.toContain('%')
})

describe('the background service', () => {
  const proxy = proxyEnvironment({
    HTTPS_PROXY: 'http://jane:p%40ss@proxy.corp:3128',
    NO_PROXY: 'localhost, .corp',
    HOME: '/x',
    http_proxy: '',
  })

  test('gets the proxy variables of the shell that installed it, and only those', () => {
    expect(proxy).toEqual([
      ['HTTPS_PROXY', 'http://jane:p%40ss@proxy.corp:3128'],
      ['NO_PROXY', 'localhost, .corp'],
    ])
  })

  test('in its LaunchAgent on macOS', () => {
    const plist = launchAgentPlist('/Users/me/.tonton/bin/tonton', '/Users/me/.tonton', [...proxy, ['NO_PROXY', 'a&b']], '/usr/bin')
    expect(plist).toContain(
      '<key>TONTON_HOME</key><string>/Users/me/.tonton</string><key>PATH</key><string>/usr/bin</string><key>HTTPS_PROXY</key><string>http://jane:p%40ss@proxy.corp:3128</string>',
    )
    expect(plist).toContain('<key>NO_PROXY</key><string>a&amp;b</string>')
    expect(launchAgentPlist('/b', '/h', [], '/bin')).toContain(
      '<dict><key>TONTON_HOME</key><string>/h</string><key>PATH</key><string>/bin</string></dict>',
    )
  })

  test('in its systemd unit on Linux, quoted, with percent signs kept', () => {
    const unit = systemdUnit('/home/me/.tonton/bin/tonton', '/home/me/.tonton', [...proxy, ['NO_PROXY', 'say "hi"\\']])
    expect(unit).toContain('Environment="HTTPS_PROXY=http://jane:p%%40ss@proxy.corp:3128"\n')
    expect(unit).toContain('Environment="NO_PROXY=localhost, .corp"\n')
    expect(unit).toContain('Environment="NO_PROXY=say \\"hi\\"\\\\"\n')
    expect(systemdUnit('/b', '/h', [], '/bin')).toContain('Environment=TONTON_HOME=/h\nEnvironment="PATH=/bin"\nExecStart="/b" service')
  })
})
