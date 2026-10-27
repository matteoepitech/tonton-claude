import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newAccountKey } from '../crypto'
import {
  blobVersion,
  needsRepublish,
  newPoolMemberSecret,
  openPoolMemberKey,
  openPoolMemberSecret,
  PoolKeyring,
  preparePoolRotation,
  publicKeyOf,
  resolvePoolKeyring,
  sealPoolMemberKey,
  sealPoolMemberSecret,
  sealVersioned,
  unwrapPoolKey,
  wrapPoolKey,
} from '../pool-keys'
import { checkPoolKeyVectors } from './pool-key-vectors'

const POOL = 'pool00000001'

/** A member with its account key, its key pair and its sealed keys, as it publishes them. */
async function member(account: string, keyring: PoolKeyring) {
  const accountKey = newAccountKey()
  const secret = await newPoolMemberSecret(POOL)
  return {
    account,
    accountKey,
    secret,
    sealedSecret: await sealPoolMemberSecret(accountKey, secret),
    publicKeys: [await sealPoolMemberKey(keyring, POOL, account, secret)],
  }
}

describe('versions of the pool key', () => {
  test('version 1 blobs have no prefix, later ones say which version sealed them, and open with it only', async () => {
    const v1 = newAccountKey()
    const v2 = newAccountKey()
    const keyring = new PoolKeyring(v1, 1)
    const old = await keyring.seal({ text: 'before' })
    expect(blobVersion(old)).toBe(1)
    expect(old).not.toContain(':')
    keyring.add(2, v2)
    const fresh = await keyring.seal({ text: 'after' })
    expect(fresh.startsWith('2:')).toBe(true)
    expect(await keyring.open(old)).toEqual({ text: 'before' })
    expect(await keyring.open(fresh)).toEqual({ text: 'after' })
    // Someone who only has version 1, like a kicked member, reads nothing newer.
    await expect(new PoolKeyring(v1, 1).open(fresh)).rejects.toThrow()
    // A blob claiming another version than the one that sealed it does not open.
    await expect(keyring.open(`2:${old}`)).rejects.toThrow()
    expect(blobVersion(await sealVersioned(v2, 7, {}))).toBe(7)
  })
})

describe('member keys and wraps', () => {
  test('a public key is bound to its member and its pool; the private one opens with the account key only', async () => {
    const keyring = new PoolKeyring(newAccountKey(), 1)
    const alice = await member('alice0000001', keyring)
    expect(await openPoolMemberKey(keyring, alice.publicKeys[0], POOL, 'alice0000001')).toBe(publicKeyOf(alice.secret))
    // Moved to another member or pool by the relay, it reads as nothing.
    expect(await openPoolMemberKey(keyring, alice.publicKeys[0], POOL, 'mallory00001')).toBeNull()
    expect(await openPoolMemberKey(keyring, alice.publicKeys[0], 'pool00000002', 'alice0000001')).toBeNull()
    expect(await openPoolMemberSecret(alice.accountKey, alice.sealedSecret, POOL)).toEqual(alice.secret)
    expect(await openPoolMemberSecret(newAccountKey(), alice.sealedSecret, POOL)).toBeNull()
  })

  test('a wrap opens for its member only, from its admin only, for its version only', async () => {
    const keyring = new PoolKeyring(newAccountKey(), 1)
    const admin = await member('admin0000001', keyring)
    const bob = await member('bob000000001', keyring)
    const eve = await member('eve000000001', keyring)
    const newKey = newAccountKey()
    const wrap = { poolId: POOL, version: 2, key: newKey, from: admin.account, to: bob.account }
    const sealed = await wrapPoolKey(admin.secret, publicKeyOf(bob.secret), wrap)
    const expected = { poolId: POOL, version: 2, from: admin.account, to: bob.account }
    expect(await unwrapPoolKey(bob.secret, publicKeyOf(admin.secret), sealed, expected)).toBe(newKey)
    // Another member's private key, or another admin's public key, opens nothing.
    expect(await unwrapPoolKey(eve.secret, publicKeyOf(admin.secret), sealed, { ...expected, to: eve.account })).toBeNull()
    expect(await unwrapPoolKey(bob.secret, publicKeyOf(eve.secret), sealed, expected)).toBeNull()
    // The relay cannot pass it off as another version or as made by someone else.
    expect(await unwrapPoolKey(bob.secret, publicKeyOf(admin.secret), sealed, { ...expected, version: 3 })).toBeNull()
    expect(await unwrapPoolKey(bob.secret, publicKeyOf(admin.secret), sealed, { ...expected, from: eve.account })).toBeNull()
  })

  test('a rotation wraps for everyone but the kicked member, who reads nothing sealed after it', async () => {
    const v1 = newAccountKey()
    const keyring = new PoolKeyring(v1, 1)
    const admin = await member('admin0000001', keyring)
    const bob = await member('bob000000001', keyring)
    const kicked = await member('kicked000001', keyring)
    const members = [admin, bob, kicked]
    const rotation = await preparePoolRotation({
      keyring,
      admin: admin.secret,
      poolId: POOL,
      account: admin.account,
      members,
      kick: kicked.account,
      newKey: newAccountKey(),
    })
    expect(rotation.version).toBe(2)
    expect(rotation.wraps.map(wrap => wrap.account).sort()).toEqual([admin.account, bob.account])
    expect(rotation.skipped).toEqual([])
    const wraps = (account: string) =>
      rotation.wraps.filter(w => w.account === account).map(w => ({ version: 2, from: admin.account, blob: w.blob }))

    const bobKeys = await resolvePoolKeyring({
      accountKey: bob.accountKey,
      poolId: POOL,
      account: bob.account,
      grant: { key: v1, version: 1 },
      secret: bob.sealedSecret,
      wraps: wraps(bob.account),
      members,
    })
    expect(bobKeys.keyring.versions()).toEqual([1, 2])
    const after = await bobKeys.keyring.seal({ text: 'SECRET after the kick' })
    expect(await bobKeys.keyring.open(after)).toEqual({ text: 'SECRET after the kick' })

    // The kicked member, even handed every wrap, opens none: they are not for it.
    const kickedKeys = await resolvePoolKeyring({
      accountKey: kicked.accountKey,
      poolId: POOL,
      account: kicked.account,
      grant: { key: v1, version: 1 },
      secret: kicked.sealedSecret,
      wraps: rotation.wraps.map(w => ({ version: 2, from: admin.account, blob: w.blob })),
      members,
    })
    expect(kickedKeys.keyring.versions()).toEqual([1])
    await expect(kickedKeys.keyring.open(after)).rejects.toThrow()
    // Bob now publishes its public key under version 2, for members who join later.
    expect(needsRepublish(bobKeys.keyring, bob.publicKeys)).toBe(true)
  })

  test('wraps open in order, each with the admin key readable at that point, and skipped members are listed', async () => {
    const v1 = newAccountKey()
    const keyring = new PoolKeyring(v1, 1)
    const admin = await member('admin0000001', keyring)
    const bob = await member('bob000000001', keyring)
    const stranger = { account: 'nokey0000001', publicKeys: [] as string[] }
    const first = await preparePoolRotation({
      keyring,
      admin: admin.secret,
      poolId: POOL,
      account: admin.account,
      members: [admin, bob, stranger],
      newKey: newAccountKey(),
    })
    expect(first.skipped).toEqual([stranger.account])
    // The admin holds version 2 and republishes its key under it, then rotates again.
    const v2 = first.wraps.find(w => w.account === admin.account)
    if (!v2) throw new Error('no wrap for the admin')
    const adminKeys = await resolvePoolKeyring({
      accountKey: admin.accountKey,
      poolId: POOL,
      account: admin.account,
      grant: { key: v1, version: 1 },
      secret: admin.sealedSecret,
      wraps: [{ version: 2, from: admin.account, blob: v2.blob }],
      members: [admin, bob],
    })
    expect(adminKeys.keyring.version).toBe(2)
    const republished = { ...admin, publicKeys: [await sealPoolMemberKey(adminKeys.keyring, POOL, admin.account, admin.secret)] }
    const second = await preparePoolRotation({
      keyring: adminKeys.keyring,
      admin: admin.secret,
      poolId: POOL,
      account: admin.account,
      members: [republished, bob],
      newKey: newAccountKey(),
    })
    expect(second.version).toBe(3)
    // Bob holds only version 1: the admin key sealed with version 2 opens once wrap 2 is in, then wrap 3 does.
    const bobWraps = [first, second].flatMap((rotation, index) =>
      rotation.wraps.filter(w => w.account === bob.account).map(w => ({ version: index + 2, from: admin.account, blob: w.blob })),
    )
    const adminBoth = { ...admin, publicKeys: [...admin.publicKeys, ...republished.publicKeys].reverse() }
    const bobKeys = await resolvePoolKeyring({
      accountKey: bob.accountKey,
      poolId: POOL,
      account: bob.account,
      grant: { key: v1, version: 1 },
      secret: bob.sealedSecret,
      wraps: bobWraps.reverse(),
      members: [adminBoth, bob],
    })
    expect(bobKeys.keyring.versions()).toEqual([1, 2, 3])
  })
})

/** Read by app/Tests/TontonCoreTests/VectorTests.swift: the Mac opens what the web made. */
const FIXTURE = join(import.meta.dir, 'pool-keys-ts.json')

describe('pool keys the Mac app reads', () => {
  test('the fixture the web made opens with the web code, as the Mac opens it', async () => {
    if (process.env.TONTON_WRITE_VECTORS === '1') {
      const key = newAccountKey()
      const v1 = newAccountKey()
      const keyring = new PoolKeyring(v1, 1)
      const secret = async (account: string) => {
        const pair = await newPoolMemberSecret(POOL)
        return {
          account,
          pair,
          secret: await sealPoolMemberSecret(key, pair),
          publicKeys: [await sealPoolMemberKey(keyring, POOL, account, pair)],
        }
      }
      const admin = await secret('admin0000001')
      const member = await secret('member000001')
      const v2 = newAccountKey()
      const wrap = await wrapPoolKey(admin.pair, publicKeyOf(member.pair), {
        poolId: POOL,
        version: 2,
        key: v2,
        from: admin.account,
        to: member.account,
      })
      const plaintext = 'Sealed after the kick ✅'
      const fixture = {
        about: 'Made by shared/test/pool-keys.test.ts (TONTON_WRITE_VECTORS=1), read by app/Tests/TontonCoreTests/VectorTests.swift.',
        key,
        poolId: POOL,
        v1,
        admin: { account: admin.account, secret: admin.secret, publicKeys: admin.publicKeys },
        member: { account: member.account, secret: member.secret, publicKeys: member.publicKeys },
        wrap: { version: 2, from: admin.account, blob: wrap },
        sealedV2: await sealVersioned(v2, 2, { text: plaintext }),
        plaintext,
      }
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`)
    }
    await checkPoolKeyVectors(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  })
})
