import CryptoKit
import XCTest

@testable import TontonCore

final class PoolKeysTests: XCTestCase {
    private let poolId = "pool00000001"

    func testBlobsSayTheirVersionAndOpenWithItOnly() throws {
        let v1 = E2E.newKey()
        var keyring = PoolKeyring(key: v1)
        let old = try keyring.seal(PoolNotes(text: "before"))
        XCTAssertEqual(PoolKeyring.version(of: old), 1)
        XCTAssertFalse(old.contains(":"))
        keyring.add(version: 2, key: E2E.newKey())
        let fresh = try keyring.seal(PoolNotes(text: "after"))
        XCTAssertTrue(fresh.hasPrefix("2:"))
        XCTAssertEqual(try keyring.open(old, as: PoolNotes.self).text, "before")
        XCTAssertEqual(try keyring.open(fresh, as: PoolNotes.self).text, "after")
        XCTAssertThrowsError(try PoolKeyring(key: v1).open(fresh, as: PoolNotes.self))
        XCTAssertThrowsError(try keyring.open("2:\(old)", as: PoolNotes.self))
    }

    func testAWrapOpensForItsMemberFromItsAdminOnly() throws {
        let admin = PoolMemberSecret(poolId: poolId, privateKey: P256.KeyAgreement.PrivateKey())
        let member = PoolMemberSecret(poolId: poolId, privateKey: P256.KeyAgreement.PrivateKey())
        let other = PoolMemberSecret(poolId: poolId, privateKey: P256.KeyAgreement.PrivateKey())
        let key = E2E.newKey()
        let blob = try PoolKeys.wrap(
            PoolKeyWrap(poolId: poolId, version: 2, key: key, from: "admin", to: "member"), admin: admin, memberPublic: member.publicKey)
        let open = { (secret: PoolMemberSecret, adminPublic: String, version: Int, from: String, to: String) in
            PoolKeys.unwrap(blob, member: secret, adminPublic: adminPublic, poolId: self.poolId, version: version, from: from, to: to)
        }
        XCTAssertEqual(open(member, admin.publicKey, 2, "admin", "member"), key)
        XCTAssertNil(open(other, admin.publicKey, 2, "admin", "other"))
        XCTAssertNil(open(member, other.publicKey, 2, "admin", "member"))
        XCTAssertNil(open(member, admin.publicKey, 3, "admin", "member"))
        XCTAssertNil(open(member, admin.publicKey, 2, "other", "member"))
    }

    func testAMemberKeyIsBoundToItsAccountAndTheSecretToTheAccountKey() throws {
        let vault = SessionVault(key: try E2E.key(fromBase64URL: E2E.newKey()))
        let keyring = PoolKeyring(key: E2E.newKey())
        let keys = try vault.newPoolMemberKeys(poolId: poolId, account: "alice", keyring: keyring)
        let secret = try XCTUnwrap(vault.poolMemberSecret(keys.secret, poolId: poolId))
        XCTAssertEqual(PoolKeys.publicKey(in: [keys.publicKey], keyring: keyring, poolId: poolId, account: "alice"), secret.publicKey)
        XCTAssertNil(PoolKeys.publicKey(in: [keys.publicKey], keyring: keyring, poolId: poolId, account: "mallory"))
        XCTAssertNil(SessionVault(key: try E2E.key(fromBase64URL: E2E.newKey())).poolMemberSecret(keys.secret, poolId: poolId))
        XCTAssertNil(vault.poolMemberSecret(keys.secret, poolId: "pool00000002"))
    }

    func testTheRelayListsKeysAndWrapsAsTheAppReadsThem() throws {
        let json = #"""
            {"t":"pool_key","poolId":"pool00000001","wrap":{"version":2,"from":"owner0000001","blob":"sealed"}}
            """#
        XCTAssertEqual(
            try JSONDecoder().decode(PoolUpdate.self, from: Data(json.utf8)),
            .key(poolId: "pool00000001", PoolKeyWrapWire(version: 2, from: "owner0000001", blob: "sealed")))
        let member = #"{"account":"a","role":"admin","joinedAt":"x","profile":null,"publicKeys":["k1","2:k2"]}"#
        XCTAssertEqual(try JSONDecoder().decode(PoolMemberWire.self, from: Data(member.utf8)).publicKeys, ["k1", "2:k2"])
        // From a relay of #216, without public keys.
        let older = #"{"account":"a","role":"member","joinedAt":"x","profile":null}"#
        XCTAssertEqual(try JSONDecoder().decode(PoolMemberWire.self, from: Data(older.utf8)).publicKeys, [])
    }
}
