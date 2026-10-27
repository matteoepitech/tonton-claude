import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APNS_TOPIC, loadConfig } from '../src/config'

const dir = mkdtempSync(join(tmpdir(), 'tonton-config-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const pem = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n'
const ids = { TONTON_APNS_KEY_ID: 'ABC123DEFG', TONTON_APNS_TEAM_ID: 'TEAM123456' }

test('pushes are off unless the relay has an APNs key', () => {
  expect(loadConfig({}).apns).toBeNull()
})

test('the key comes from a file or inline, with the app published here as the default topic', () => {
  const file = join(dir, 'AuthKey.p8')
  writeFileSync(file, pem)
  expect(loadConfig({ ...ids, TONTON_APNS_KEY_FILE: file }).apns).toEqual({
    key: pem,
    keyId: 'ABC123DEFG',
    teamId: 'TEAM123456',
    topic: DEFAULT_APNS_TOPIC,
  })
  const inline = loadConfig({ ...ids, TONTON_APNS_KEY: pem.replaceAll('\n', '\\n'), TONTON_APNS_TOPIC: 'com.example.tonton' }).apns
  expect(inline).toMatchObject({ key: pem, topic: 'com.example.tonton' })
})

test('a half-done setup stops the relay instead of failing every push', () => {
  expect(() => loadConfig({ TONTON_APNS_KEY_ID: 'ABC123DEFG' })).toThrow('APNs needs')
  expect(() => loadConfig({ ...ids, TONTON_APNS_KEY: 'not a key' })).toThrow('.p8')
  expect(() => loadConfig({ ...ids, TONTON_APNS_KEY: pem, TONTON_APNS_KEY_ID: 'short' })).toThrow('key id')
  expect(() => loadConfig({ ...ids, TONTON_APNS_KEY: pem, TONTON_APNS_TOPIC: 'bad topic' })).toThrow('bundle id')
  expect(() => loadConfig({ ...ids, TONTON_APNS_KEY_FILE: join(dir, 'missing.p8') })).toThrow()
})
