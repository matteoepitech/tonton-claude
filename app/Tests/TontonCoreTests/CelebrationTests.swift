import XCTest

@testable import TontonCore

final class CelebrationTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_793_005_200)

    private func session(_ status: SessionStatus) -> SessionSummary {
        SessionSummary(
            id: "s1", machineId: "m", machine: "PC", platform: nil, cwd: "/x", project: "api", title: nil, status: status,
            statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: start,
            lastActivity: start, lastMessage: nil)
    }

    func testATaskLastsFromItsFirstWorkToDoneThroughApprovals() {
        var timer = WorkTimer()
        XCTAssertNil(timer.update(session(.working), previous: .idle, at: start))
        XCTAssertNil(timer.update(session(.permission), previous: .working, at: start + 60))
        XCTAssertNil(timer.update(session(.working), previous: .permission, at: start + 90))
        XCTAssertEqual(timer.update(session(.idle), previous: .working, at: start + 1200), 1200)
        // The next task starts over.
        XCTAssertNil(timer.update(session(.working), previous: .idle, at: start + 1300))
        XCTAssertEqual(timer.update(session(.idle), previous: .working, at: start + 1360), 60)
    }

    func testAStopOtherThanDoneIsNoTaskDone() {
        var timer = WorkTimer()
        _ = timer.update(session(.working), previous: nil, at: start)
        XCTAssertNil(timer.update(session(.error), previous: .working, at: start + 600))
        XCTAssertNil(timer.update(session(.idle), previous: .error, at: start + 700))
    }

    func testConfettiFliesThenFallsAndFades() {
        let pieces = Confetti.pieces(seed: 42, colors: 6)
        XCTAssertEqual(pieces, Confetti.pieces(seed: 42, colors: 6))
        XCTAssertNotEqual(pieces, Confetti.pieces(seed: 43, colors: 6))
        XCTAssertTrue(pieces.allSatisfy { (0..<6).contains($0.color) })
        let origin = CGPoint(x: 380, y: 32)
        for piece in pieces {
            XCTAssertEqual(Confetti.placement(of: piece, at: 0, from: origin).position, origin)
            XCTAssertGreaterThan(Confetti.placement(of: piece, at: 2, from: origin).position.y, origin.y)
            XCTAssertEqual(Confetti.placement(of: piece, at: 1, from: origin).opacity, 1)
            XCTAssertEqual(Confetti.placement(of: piece, at: Confetti.duration, from: origin).opacity, 0)
        }
    }
}
