import XCTest

@testable import TontonCore

final class ConversationSearchTests: XCTestCase {
    private let conversations: [String: [Entry]] = [
        "s1": [
            Entry(id: "u1", ts: "2026-10-26T10:00:00Z", kind: .user, text: "Pourquoi le déploiement échoue ?"),
            Entry(id: "a1", ts: "2026-10-26T10:00:05Z", kind: .assistant, text: "The deploy fails because the token expired."),
            Entry(id: "t1", ts: "2026-10-26T10:00:06Z", kind: .tool, toolUseId: "x1", name: "Bash", summary: "npm run deploy"),
            Entry(id: "r1", ts: "2026-10-26T10:00:09Z", kind: .toolResult, text: "Error: token expired at 09:58", toolUseId: "x1"),
        ],
        "s2": [Entry(id: "a2", ts: "2026-10-26T11:00:00Z", kind: .assistant, text: "Renewed the token, deploy is green.")],
    ]

    func testEveryWordIgnoringCaseAndAccents() {
        XCTAssertEqual(ConversationSearch.search("DEPLOIEMENT", in: conversations).map(\.itemId), ["u1"])
        XCTAssertEqual(ConversationSearch.search("token deploy", in: conversations).map(\.itemId), ["a2", "a1"])
        XCTAssertEqual(ConversationSearch.search("   ", in: conversations), [])
    }

    func testAToolResultLeadsToItsCall() {
        let hit = ConversationSearch.search("09:58", in: conversations).first
        XCTAssertEqual(hit?.itemId, "t1")
        XCTAssertEqual(hit?.kind, .toolResult)
        XCTAssertEqual(ConversationSearch.search("npm run", in: conversations).first?.itemId, "t1")
    }

    func testSnippetsCenterOnTheMatch() {
        let long = String(repeating: "a ", count: 100) + "needle" + String(repeating: " b", count: 100)
        let snippet = ConversationSearch.snippet(long, around: "needle")
        XCTAssertTrue(snippet.hasPrefix("…"))
        XCTAssertTrue(snippet.hasSuffix("…"))
        XCTAssertTrue(snippet.contains("needle"))
        XCTAssertLessThanOrEqual(snippet.count, 142)
    }
}
