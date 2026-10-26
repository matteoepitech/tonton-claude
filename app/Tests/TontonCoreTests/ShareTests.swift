import XCTest

@testable import TontonCore

final class ShareTests: XCTestCase {
    func testTheShareKeyGoesBackToWhatMadeIt() throws {
        let link = ShareLink(
            relay: "https://tonton.example.com", token: "ts_abcdefghijkl_" + String(repeating: "t", count: 43), key: E2E.newKey())
        XCTAssertTrue(link.string.hasPrefix("tontonshare1."))
        XCTAssertEqual(ShareLink(string: "  \(link.string)\n"), link)
    }

    func testAnythingElseIsNotAShareKey() throws {
        let account = Account(relay: "https://tonton.example.com", accountId: "a", token: "ta_x", key: E2E.newKey())
        XCTAssertNil(ShareLink(string: account.recoveryKey))
        XCTAssertNil(ShareLink(string: "tontonshare1.nope"))
        let badKey = ShareLink(relay: "https://tonton.example.com", token: "ts_x", key: "short")
        XCTAssertNil(ShareLink(string: badKey.string))
    }

    func testTheOrderTellsTheAgentWhichShareAndSessionAndUntilWhen() throws {
        let key = E2E.newKey()
        let vault = SessionVault(key: try E2E.key(fromBase64URL: key))
        let shareKey = E2E.newKey()
        let sealed = try vault.sealShareOrder(shareId: "sh1", sessionId: "ses_1", shareKey: shareKey, expiresAt: "2026-10-27T10:00:00.000Z")
        let order = try E2E.open(sealed, as: ShareOrder.self, with: try E2E.key(fromBase64URL: key))
        XCTAssertEqual(
            [order.shareId, order.sessionId, order.key, order.expiresAt], ["sh1", "ses_1", shareKey, "2026-10-27T10:00:00.000Z"])
    }

    func testTheListReadsAsTheRelaySendsIt() throws {
        let json =
            #"[{"id":"abcdefghijkl","sessionId":"ses_1","createdAt":"2026-10-26T10:00:00.000Z","expiresAt":"2026-10-27T10:00:00.000Z","viewers":2}]"#
        let shares = try JSONDecoder().decode([ShareSummary].self, from: Data(json.utf8))
        XCTAssertEqual(shares.first?.viewers, 2)
        XCTAssertEqual(shares.first?.expires, Date(timeIntervalSince1970: 1_793_095_200))
        XCTAssertEqual(ShareDuration.allCases.map(\.hours), [1, 24, 168])
    }

    func testOnlyAgentsThatSealSharesAreAskedTo() {
        let machine = { (version: String?) in
            MachineInfo(id: "m1", name: "PC", platform: nil, createdAt: Date(), lastSeen: nil, online: true, agentVersion: version)
        }
        XCTAssertEqual(["0.7.0", "0.8.0", "0.10.1", "0.0.0"].map { machine($0).sealsShares }, [false, true, true, true])
        XCTAssertFalse(machine(nil).sealsShares)
        XCTAssertEqual(["0.7.9", "0.8.0", "0.0.0"].map { machine($0).keepsSessionRules }, [false, true, true])
    }
}
