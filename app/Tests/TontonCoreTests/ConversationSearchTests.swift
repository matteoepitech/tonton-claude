import XCTest

@testable import TontonCore

final class ConversationSearchTests: XCTestCase {
    private func session(_ id: String) -> SessionSummary {
        SessionSummary(
            id: id, machineId: "m", machine: "m", platform: nil, cwd: "/", project: id, title: nil, status: .idle, statusText: nil,
            agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: Date(), lastActivity: Date(),
            lastMessage: nil)
    }

    private let entries: [String: [Entry]] = [
        "a": [
            Entry(id: "1", ts: "", kind: .user, text: "Why does the Déploiement fail?"),
            Entry(id: "2", ts: "", kind: .tool, toolUseId: "t", name: "Bash", summary: "npm run deploy"),
            Entry(id: "3", ts: "", kind: .toolResult, text: "Error: deploy key missing", toolUseId: "t", isError: true),
            Entry(id: "4", ts: "", kind: .assistant, text: "The deploy key is missing from the CI secrets."),
        ],
        "b": [Entry(id: "5", ts: "", kind: .assistant, text: "Deployed to production.")],
    ]

    func testMostRecentFirstAcrossSessionsIgnoringCaseAndAccents() {
        let matches = ConversationSearch.search("DEPLOI", sessions: [session("a"), session("b")], entries: entries)
        XCTAssertEqual(matches.map(\.id), ["a/1"])
        let deploy = ConversationSearch.search("deploy", sessions: [session("a"), session("b")], entries: entries)
        XCTAssertEqual(deploy.map(\.id), ["a/4", "a/2", "b/5"])
    }

    func testAToolResultJumpsToItsCall() {
        let match = ConversationSearch.search("key missing", sessions: [session("a")], entries: entries).last
        XCTAssertEqual(match?.kind, .toolResult)
        XCTAssertEqual(match?.itemId, "2")
    }

    func testShortQueriesAndLimit() {
        XCTAssertEqual(ConversationSearch.search("de", sessions: [session("a")], entries: entries), [])
        XCTAssertEqual(ConversationSearch.search("deploy", sessions: [session("a"), session("b")], entries: entries, limit: 2).count, 2)
    }

    func testSnippetsAreShortAndOnOneLine() {
        let long = String(repeating: "word ", count: 30) + "needle\nhere " + String(repeating: "more ", count: 30)
        let match = ConversationSearch.search(
            "needle", sessions: [session("c")], entries: ["c": [Entry(id: "x", ts: "", kind: .user, text: long)]])
        let snippet = match.first?.snippet ?? ""
        XCTAssertTrue(snippet.hasPrefix("…") && snippet.hasSuffix("…"))
        XCTAssertTrue(snippet.contains("needle here"))
        XCTAssertLessThanOrEqual(snippet.count, 2 * 40 + "needle".count + 2)
    }

    func testSubagentCallsAreLeftOutOfTheSearch() {
        let entries = [
            Entry(id: "t", ts: "2026-10-27T10:00:00Z", kind: .tool, toolUseId: "toolu_task", name: "Agent", summary: "Review"),
            Entry(
                id: "s", ts: "2026-10-27T10:00:01Z", kind: .subagentTool, toolUseId: "toolu_1", name: "Grep", summary: "needle",
                parent: "toolu_task"),
            Entry(
                id: "r", ts: "2026-10-27T10:00:02Z", kind: .subagentResult, text: "needle", toolUseId: "toolu_1", isError: true,
                parent: "toolu_task"),
        ]
        XCTAssertEqual(ConversationSearch.search("needle", sessions: [session("s1")], entries: ["s1": entries]), [])
    }
}
