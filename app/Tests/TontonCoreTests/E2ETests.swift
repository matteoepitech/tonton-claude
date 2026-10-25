import CryptoKit
import XCTest

@testable import TontonCore

final class E2ETests: XCTestCase {
    /// Sealed by agent/src/crypto.ts with a key of 32 bytes set to 42: proves both sides speak the same format.
    private let agentKey = "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio"
    private let agentBlob =
        "ZehR9PS/l2kdtPyZqmFYXG8drslHTtBrq9ZYem1N1OqPa+lf/p0FlHAmPWU0wPYLbBFtR9DTEHz2B6snMF5le09mGULumL2Rwk0MQKkZUMmHUXrZV1Pq+sw5jd/z8v7UnO2MRLYA5S7usdO/Vw=="

    func testOpensWhatTheAgentSealed() throws {
        let entry = try E2E.open(agentBlob, as: Entry.self, with: try E2E.key(fromBase64URL: agentKey))
        XCTAssertEqual(entry.kind, .assistant)
        XCTAssertEqual(entry.text, "Déployé ✅")
    }

    func testRoundTrip() throws {
        let key = try E2E.key(fromBase64URL: E2E.newKey())
        let sealed = try E2E.seal(["text": "hello"], with: key)
        XCTAssertEqual(try E2E.open(sealed, as: [String: String].self, with: key), ["text": "hello"])
    }

    func testRejectsAnotherKey() throws {
        let other = try E2E.key(fromBase64URL: E2E.newKey())
        XCTAssertThrowsError(try E2E.open(agentBlob, as: Entry.self, with: other))
    }

    func testRejectsTamperedBlob() throws {
        var bytes = try XCTUnwrap(Data(base64Encoded: agentBlob))
        bytes[20] ^= 1
        XCTAssertThrowsError(try E2E.open(bytes.base64EncodedString(), as: Entry.self, with: try E2E.key(fromBase64URL: agentKey)))
    }

    func testKeysMustBe256Bits() {
        XCTAssertThrowsError(try E2E.key(fromBase64URL: "c2hvcnQ"))
        XCTAssertEqual(Data(base64URLEncoded: E2E.newKey())?.count, 32)
    }
}
