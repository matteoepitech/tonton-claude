import XCTest

@testable import TontonCore

final class AccountTests: XCTestCase {
    func testRecoveryKeyRoundTrip() throws {
        let account = Account(relay: "https://tonton.d3l.tech", accountId: "abc", token: "ta_x", key: E2E.newKey())
        XCTAssertTrue(account.recoveryKey.hasPrefix("tonton1."))
        XCTAssertEqual(Account(recoveryKey: "  \(account.recoveryKey)\n"), account)
    }

    /// The Windows and Linux island creates accounts too: its key, from `encodeRecoveryKey` (shared/test/recovery-key.test.ts),
    /// signs in on a Mac with the join secret of the account token.
    func testRestoresAKeyWrittenByTheClientCore() throws {
        let key =
            "tonton1.eyJyZWxheSI6Imh0dHBzOi8vdG9udG9uLmQzbC50ZWNoIiwiYWNjb3VudElkIjoiYWNjdDEyMzQ1Njc4IiwidG9rZW4iOiJ0YV9BYkNkRWYwMTIzNDU2Nzg5Iiwia2V5Ijoib3plNkxiTlhlU0lpRW5qd0VMZ2o2TjJPbHVnbjBsYjVPZ1VaeEJUVkpucyIsImpvaW5TZWNyZXQiOiJTM2NyM3RTM2NyM3RTM2NyM3RTM2NyM3RTM2NyM3RTM2NyM3RTM2NyM3RTIn0"
        let account = try XCTUnwrap(Account(recoveryKey: key))
        XCTAssertEqual(
            account,
            Account(
                relay: "https://tonton.d3l.tech", accountId: "acct12345678", token: "ta_AbCdEf0123456789",
                key: "oze6LbNXeSIiEnjwELgj6N2Olugn0lb5OgUZxBTVJns", joinSecret: "S3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS"))
        XCTAssertNotNil(account.machineToken)
    }

    func testRejectsAnythingElse() {
        XCTAssertNil(Account(recoveryKey: ""))
        XCTAssertNil(Account(recoveryKey: "tonton1.not-base64!"))
        let badKey = Account(relay: "https://r", accountId: "a", token: "t", key: "short")
        XCTAssertNil(Account(recoveryKey: badKey.recoveryKey))
    }

    func testRelayURLsAreNormalized() {
        XCTAssertEqual(RelayAPI.normalize("  https://relay.example.com/ \n"), "https://relay.example.com")
    }
}
