import XCTest

@testable import TontonCore

final class AccountTests: XCTestCase {
    func testRecoveryKeyRoundTrip() throws {
        let account = Account(relay: "https://tonton.d3l.tech", accountId: "abc", token: "ta_x", key: E2E.newKey())
        XCTAssertTrue(account.recoveryKey.hasPrefix("tonton1."))
        XCTAssertEqual(Account(recoveryKey: "  \(account.recoveryKey)\n"), account)
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
