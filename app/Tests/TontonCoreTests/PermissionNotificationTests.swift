import XCTest

@testable import TontonCore

final class PermissionNotificationTests: XCTestCase {
    private let request = PermissionRequest(
        requestId: "abcde", toolName: "Bash", description: "Run the tests", inputPreview: #"{"command":"npm test"}"#, ts: "")

    private func session(_ id: String, pending: [PermissionRequest]) -> SessionSummary {
        let now = Date(timeIntervalSince1970: 1_793_005_200)
        return SessionSummary(
            id: id, machineId: "m1", machine: "PC", platform: nil, cwd: "/x", project: "x", title: nil, status: .permission,
            statusText: nil, agentOnline: true, canChat: true, pendingPermissions: pending, costUSD: nil, startedAt: now, lastActivity: now,
            lastMessage: nil, terminal: false)
    }

    private func decide(_ action: String, _ sessions: [SessionSummary]) -> PermissionNotification.Decision {
        PermissionNotification.decide(
            actionIdentifier: action, userInfo: PermissionNotification.userInfo(sessionId: "s1", requestId: "abcde"), sessions: sessions)
    }

    func testEachButtonAnswersThePendingRequest() {
        let sessions = [session("s1", pending: [request])]
        for action in PermissionNotification.Action.allCases {
            XCTAssertEqual(decide(action.rawValue, sessions), .answer(sessionId: "s1", request: request, action))
        }
    }

    func testAClickOnTheNotificationItselfOpensTheNotchOnTheSession() {
        XCTAssertEqual(decide("com.apple.UNNotificationDefaultActionIdentifier", []), .open(sessionId: "s1"))
        XCTAssertEqual(
            PermissionNotification.decide(actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier", userInfo: [:], sessions: []),
            .open(sessionId: nil))
    }

    func testARequestAnsweredElsewhereIsLeftAlone() {
        let other = PermissionRequest(requestId: "fghij", toolName: "Edit", description: "Edit", inputPreview: "{}", ts: "")
        // Answered in the notch or the terminal, its session gone, or a notification without a request.
        XCTAssertEqual(decide(PermissionNotification.Action.allow.rawValue, [session("s1", pending: [other])]), .ignore)
        XCTAssertEqual(decide(PermissionNotification.Action.deny.rawValue, []), .ignore)
        XCTAssertEqual(
            PermissionNotification.decide(
                actionIdentifier: PermissionNotification.Action.allow.rawValue, userInfo: ["sessionId": "s1"],
                sessions: [session("s1", pending: [request])]),
            .ignore)
    }

    func testNotificationsOfClosedRequestsAreTheOnesToTakeAway() {
        let id = { (session: String, request: String) in PermissionNotification.identifier(sessionId: session, requestId: request) }
        let posted: Set = [id("s1", "abcde"), id("s1", "old"), id("s2", "abcde")]
        let sessions = [session("s1", pending: [request])]
        XCTAssertEqual(PermissionNotification.stale(posted: posted, sessions: sessions), [id("s1", "old"), id("s2", "abcde")])
        XCTAssertEqual(PermissionNotification.stale(posted: [], sessions: sessions), [])
        XCTAssertNotEqual(id("s1", "abcde"), id("s2", "abcde"))
    }
}
