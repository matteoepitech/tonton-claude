import XCTest

@testable import TontonCore

final class ScriptingTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    private func session(
        _ id: String, project: String = "api", status: SessionStatus = .working, canChat: Bool = true, minutesAgo: Double = 0
    ) -> SessionSummary {
        SessionSummary(
            id: id, machineId: "m", machine: "PC", platform: nil, cwd: "/code/\(project)", project: project, title: "Fix the login",
            status: status, statusText: nil, agentOnline: true, canChat: canChat, pendingPermissions: [], costUSD: 1.234,
            startedAt: now, lastActivity: now.addingTimeInterval(-minutesAgo * 60), lastMessage: nil)
    }

    func testFindsBySessionIdThenByProject() {
        let sessions = [session("s1", project: "api"), session("s2", project: "web")]
        XCTAssertEqual(try ScriptSessions.find("s2", in: sessions).get().id, "s2")
        XCTAssertEqual(try ScriptSessions.find("  API ", in: sessions).get().id, "s1")
        XCTAssertEqual(ScriptSessions.find("docs", in: sessions), .failure(.notFound("docs")))
    }

    func testTheLiveSessionOfAProjectWinsAndTwoLiveOnesNeedTheId() {
        let ended = session("old", status: .ended, minutesAgo: 5)
        XCTAssertEqual(try ScriptSessions.find("api", in: [ended, session("new", status: .idle)]).get().id, "new")
        XCTAssertEqual(
            ScriptSessions.find("api", in: [session("a"), session("b", status: .waiting)]), .failure(.ambiguous("api", ["a", "b"])))
        // With none live, the latest one, to read how it ended.
        let older = session("older", status: .ended, minutesAgo: 60)
        XCTAssertEqual(try ScriptSessions.find("api", in: [older, ended]).get().id, "old")
    }

    func testSendingNeedsTheSettingTextAndAChannel() {
        let sessions = [session("s1"), session("local", project: "web", canChat: false)]
        XCTAssertEqual(ScriptSessions.recipient("api", text: "go", in: sessions, allowed: false), .failure(.sendingOff))
        XCTAssertEqual(ScriptSessions.recipient("api", text: " \n", in: sessions, allowed: true), .failure(.emptyMessage))
        XCTAssertEqual(ScriptSessions.recipient("web", text: "go", in: sessions, allowed: true), .failure(.cannotChat("web")))
        XCTAssertEqual(try ScriptSessions.recipient("api", text: "go", in: sessions, allowed: true).get().id, "s1")
    }

    func testRecordsShowTheCostOnlyWhenCostsAreShown() {
        let fields = ScriptSessions.fields(session("s1"), showCost: true)
        XCTAssertEqual(fields.map(\.0), ["session", "project", "machine", "status", "title", "folder", "cost"])
        XCTAssertEqual(fields.map(\.1), ["s1", "api", "PC", "working", "Fix the login", "/code/api", "1.23"])
        XCTAssertFalse(ScriptSessions.fields(session("s1"), showCost: false).contains { $0.0 == "cost" })
    }
}
