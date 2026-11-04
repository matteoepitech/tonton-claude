import XCTest

@testable import TontonCore

final class LiveActivityTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    private func session(
        _ id: String, _ status: SessionStatus, title: String? = nil, ago: TimeInterval = 0, text: String? = nil,
        asks: [PermissionRequest] = []
    )
        -> SessionSummary
    {
        SessionSummary(
            id: id, machineId: "m", machine: "PC", platform: nil, cwd: "/x", project: id, title: title, status: status,
            statusText: text, agentOnline: true, canChat: true, pendingPermissions: asks, costUSD: nil, startedAt: now,
            lastActivity: now - ago, lastMessage: nil)
    }

    func testTheSessionThatNeedsTheUserComesFirstThenTheLatestAtWork() {
        let older = session("older", .working, ago: 60)
        let newer = session("newer", .working)
        let asking = session("asking", .permission, ago: 600)
        XCTAssertEqual(LiveActivity.pick([older, newer, session("done", .idle)])?.id, "newer")
        XCTAssertEqual(LiveActivity.pick([older, asking, newer])?.id, "asking")
        XCTAssertNil(LiveActivity.pick([session("done", .idle), session("closed", .ended)]))
    }

    func testItSaysWhatTheSessionNeedsOrWorksOn() {
        XCTAssertEqual(LiveActivity.text(session("a", .working, title: "Fix the login")), "Fix the login")
        XCTAssertEqual(
            LiveActivity.text(session("a", .permission, title: "Fix", text: "Claude needs your permission to use Bash")),
            "Wants to use Bash")
        XCTAssertEqual(LiveActivity.text(session("a", .working)), "Working")
    }

    /// Claude Code 2.1.160 and later say only "Claude needs your permission".
    func testThePendingRequestNamesTheToolTheTextLeavesOut() {
        let edit = PermissionRequest(requestId: "r1", toolName: "Edit", description: "Edit a.ts", inputPreview: "{}", ts: "")
        XCTAssertEqual(
            LiveActivity.text(session("a", .permission, text: "Claude needs your permission", asks: [edit])), "Wants to use Edit")
        XCTAssertEqual(LiveActivity.text(session("a", .permission, text: "Claude needs your permission")), "Needs approval")
        XCTAssertEqual(
            LiveActivity.text(session("a", .permission, text: "OpenCode needs your permission to use bash", asks: [edit])),
            "Wants to use bash")
    }
}
