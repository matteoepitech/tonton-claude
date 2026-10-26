import XCTest

@testable import TontonCore

final class PillRowTests: XCTestCase {
    private func sessions(_ count: Int, status: SessionStatus = .working) -> [SessionSummary] {
        (0..<count).map { index in
            SessionSummary(
                id: "s\(index)", machineId: "m", machine: "PC", platform: nil, cwd: "/x", project: "p\(index)", title: nil,
                status: status, statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil,
                startedAt: .now, lastActivity: .now, lastMessage: nil)
        }
    }

    func testOnlyLiveSessionsWithTheRestCountedOnTheLastPill() {
        XCTAssertEqual(PillRow(sessions(3) + sessions(2, status: .ended)).sessions.count, 3)
        let crowded = PillRow(sessions(9))
        XCTAssertEqual(crowded.sessions.map(\.id), ["s0", "s1", "s2", "s3", "s4"])
        XCTAssertEqual(crowded.more, 4)
        XCTAssertEqual(crowded.pillCount, 6)
        XCTAssertEqual(PillRow([]).width, 0)
    }

    func testTheClickedPill() {
        let row = PillRow(sessions(3))
        XCTAssertEqual(row.width, 3 * 104 + 2 * 6)
        XCTAssertEqual(row.pill(at: 10), 0)
        XCTAssertEqual(row.pill(at: 104 + 6 + 1), 1)
        XCTAssertNil(row.pill(at: 104 + 3), "between two pills")
        XCTAssertEqual(row.pill(at: row.width - 1), 2)
        XCTAssertNil(row.pill(at: row.width + 1))
        XCTAssertNil(row.pill(at: -1))
    }
}
