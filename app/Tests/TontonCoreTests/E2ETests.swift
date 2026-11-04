import CryptoKit
import XCTest

@testable import TontonCore

final class E2ETests: XCTestCase {
    /// Sealed by shared/crypto.ts with a key of 32 bytes set to 42: proves both sides speak the same format. The other way
    /// round, shared/test/swift-vectors.test.ts opens what VectorTests seals.
    private let agentKey = "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio"
    private let agentBlob =
        "ZehR9PS/l2kdtPyZqmFYXG8drslHTtBrq9ZYem1N1OqPa+lf/p0FlHAmPWU0wPYLbBFtR9DTEHz2B6snMF5le09mGULumL2Rwk0MQKkZUMmHUXrZV1Pq+sw5jd/z8v7UnO2MRLYA5S7usdO/Vw=="

    func testOpensWhatTheAgentSealed() throws {
        let entry = try E2E.open(agentBlob, as: Entry.self, with: try E2E.key(fromBase64URL: agentKey))
        XCTAssertEqual(entry.kind, .assistant)
        XCTAssertEqual(entry.text, "Déployé ✅")
    }

    /// The same, from an entry whose text ends on half an emoji: JSON.stringify would write it as a lone `\ud83c`, which
    /// JSONDecoder refuses with the whole entry, so the agent seals U+FFFD in its place.
    private let halfEmojiBlob =
        "n5YUx58tefZX4BVTvCJLBESGzwfpJYYX3Nl4K7iIPwnGaXnqxqrw42w/DKl2f+z/TWUQZPCrUQjYKBP/y13A9veLF5jOYGGWVSJwM/dMBW/am/2weNl1FWgfwW9wpfAjvsuKqyhxdV4Nhc9+JmBEaA=="

    func testOpensWhatTheAgentSealedFromHalfAnEmoji() throws {
        let entry = try E2E.open(halfEmojiBlob, as: Entry.self, with: try E2E.key(fromBase64URL: agentKey))
        XCTAssertEqual(entry.text, "Déployé \u{FFFD}")
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
