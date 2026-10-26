import XCTest

@testable import TontonCore

final class FinishedSessionsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    private func session(_ status: SessionStatus, hoursAgo: Double) -> SessionSummary {
        let last = now.addingTimeInterval(-hoursAgo * 3600)
        return SessionSummary(
            id: "s", machineId: "m", machine: "PC", platform: nil, cwd: "/x", project: "x", title: nil, status: status, statusText: nil,
            agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: last, lastActivity: last, lastMessage: nil)
    }

    func testRightAwayHidesClosedAndOfflineSessionsTheMomentTheyFinish() {
        XCTAssertFalse(FinishedSessions.isShown(session(.ended, hoursAgo: 0), hideAfterHours: FinishedSessions.rightAway, now: now))
        XCTAssertFalse(FinishedSessions.isShown(session(.offline, hoursAgo: 0), hideAfterHours: FinishedSessions.rightAway, now: now))
        // Live sessions always show, done or not.
        for status in [SessionStatus.idle, .working, .waiting, .permission, .error, .starting] {
            XCTAssertTrue(FinishedSessions.isShown(session(status, hoursAgo: 48), hideAfterHours: FinishedSessions.rightAway, now: now))
        }
    }

    func testTheDelaysAndNever() {
        XCTAssertTrue(FinishedSessions.isShown(session(.ended, hoursAgo: 0.5), hideAfterHours: 1, now: now))
        XCTAssertFalse(FinishedSessions.isShown(session(.ended, hoursAgo: 2), hideAfterHours: 1, now: now))
        XCTAssertTrue(FinishedSessions.isShown(session(.ended, hoursAgo: 500), hideAfterHours: 0, now: now))
    }

    func testTheEyeButtonHidesAllThenGivesBackTheDelay() {
        XCTAssertEqual(FinishedSessions.toggled(6, previous: 0), FinishedSessions.rightAway)
        XCTAssertEqual(FinishedSessions.toggled(FinishedSessions.rightAway, previous: 6), 6)
        XCTAssertEqual(FinishedSessions.toggled(FinishedSessions.rightAway, previous: FinishedSessions.rightAway), 0)
    }
}
