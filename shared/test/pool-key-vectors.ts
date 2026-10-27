// Checks the pool key vectors of both implementations the same way: shared/test/pool-keys-ts.json (made by the web code)
// and the `poolKeys` of shared/test/swift-vectors.json (made by the Mac's).
import { expect } from 'bun:test'
import { resolvePoolKeyring } from '../pool-keys'

/** The member opens version 2 from the admin's wrap, and with it the blob sealed after the rotation. */
export async function checkPoolKeyVectors(vectors: {
  key: string
  poolId: string
  v1: string
  admin: { account: string; publicKeys: string[] }
  member: { account: string; secret: string; publicKeys: string[] }
  wrap: { version: number; from: string; blob: string }
  sealedV2: string
  plaintext: string
}) {
  const { keyring } = await resolvePoolKeyring({
    accountKey: vectors.key,
    poolId: vectors.poolId,
    account: vectors.member.account,
    grant: { key: vectors.v1, version: 1 },
    secret: vectors.member.secret,
    wraps: [vectors.wrap],
    members: [vectors.admin, vectors.member],
  })
  expect(keyring.versions()).toEqual([1, 2])
  expect(await keyring.open(vectors.sealedV2)).toEqual({ text: vectors.plaintext })
}
