import XCTest

@testable import TontonCore

final class SessionFoldingTests: XCTestCase {
    private func session(_ id: String, machine: String, status: SessionStatus = .idle) -> SessionSummary {
        SessionSummary(
            id: id, machineId: "id-\(machine)", machine: machine, platform: nil, cwd: "/code/\(id)", project: id, title: nil,
            status: status, statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: nil,
            startedAt: Date(timeIntervalSince1970: 0), lastActivity: Date(timeIntervalSince1970: 0), lastMessage: nil)
    }

    func testKeysAreStableAndDistinctPerSection() {
        let keys = [SessionSection.Kind.pinned, .thisMac, .tag("acme"), .machine("acme"), .machine("PC")].map(SessionFolding.key)
        XCTAssertEqual(keys, ["pinned", "thisMac", "tag:acme", "machine:acme", "machine:PC"])
        XCTAssertEqual(Set(keys).count, keys.count)
    }

    func testTogglingFoldsThenUnfolds() {
        let folded = SessionFolding.toggled(.machine("PC"), in: [])
        XCTAssertEqual(folded, ["machine:PC"])
        XCTAssertEqual(SessionFolding.toggled(.machine("PC"), in: folded), [])
        XCTAssertEqual(SessionFolding.toggled(.thisMac, in: folded), ["machine:PC", "thisMac"])
    }

    func testFoldedSectionsLeaveTheKeyboardOrderButNotASearch() {
        let sessions = [session("a", machine: "PC"), session("b", machine: "Studio"), session("c", machine: "PC")]
        let sections = SessionLayout.sections(sessions, pinned: ["c"])
        let all = SessionFolding.shown(sections, folded: [])
        XCTAssertEqual(all.map(\.id), ["c", "a", "b"])
        XCTAssertEqual(SessionFolding.shown(sections, folded: ["machine:PC"]).map(\.id), ["c", "b"])
        XCTAssertEqual(SessionFolding.shown(sections, folded: ["pinned", "machine:Studio"]).map(\.id), ["a"])
        XCTAssertEqual(
            SessionFolding.shown(sections, folded: ["pinned", "machine:PC", "machine:Studio"], searching: true).map(\.id), ["c", "a", "b"])
        // A folded section that no longer exists changes nothing.
        XCTAssertEqual(SessionFolding.shown(sections, folded: ["machine:Gone", "tag:old"]).map(\.id), ["c", "a", "b"])
    }

    func testTheSummarySaysHowManyAreHiddenAndTheMostPressingOne() {
        XCTAssertEqual(SessionFolding.summary([]), .init(hidden: 0, attention: nil))
        let quiet = [session("a", machine: "PC", status: .working), session("b", machine: "PC", status: .idle)]
        XCTAssertEqual(SessionFolding.summary(quiet), .init(hidden: 2, attention: nil))
        let asking = quiet + [session("c", machine: "PC", status: .waiting), session("d", machine: "PC", status: .error)]
        XCTAssertEqual(SessionFolding.summary(asking).attention, .error)
        let permission = asking + [session("e", machine: "PC", status: .permission)]
        XCTAssertEqual(SessionFolding.summary(permission), .init(hidden: 5, attention: .permission))
    }
}
