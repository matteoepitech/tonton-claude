import XCTest

@testable import TontonCore

final class SessionLayoutTests: XCTestCase {
    private func session(_ id: String, on machine: String, _ status: SessionStatus = .working) -> SessionSummary {
        SessionSummary(
            id: id, machineId: machine, machine: machine, platform: nil, cwd: "/", project: id, title: nil, status: status,
            statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil, startedAt: Date(),
            lastActivity: Date(), lastMessage: nil)
    }

    func testPinnedSessionsComeFirstInTheOrderTheyWerePinned() {
        let sessions = [session("a", on: "laptop"), session("b", on: "server"), session("c", on: "laptop")]
        let sections = SessionLayout.sections(sessions, pinned: ["c", "b"])
        XCTAssertEqual(sections.map(\.kind), [.pinned, .machine("laptop")])
        XCTAssertEqual(sections.map { $0.sessions.map(\.id) }, [["c", "b"], ["a"]])
        XCTAssertEqual(SessionLayout.ordered(sessions, pinned: ["c", "b"]).map(\.id), ["c", "b", "a"])
    }

    func testMachinesWithALiveSessionComeFirstThenByName() {
        let sessions = [session("a", on: "zeta"), session("b", on: "alpha", .ended), session("c", on: "Beta")]
        XCTAssertEqual(SessionLayout.sections(sessions, pinned: []).map(\.kind), [.machine("Beta"), .machine("zeta"), .machine("alpha")])
    }

    func testPinsOfSessionsThatAreNotListedAreIgnored() {
        let sections = SessionLayout.sections([session("a", on: "laptop")], pinned: ["gone"])
        XCTAssertEqual(sections.map(\.kind), [.machine("laptop")])
    }
}
