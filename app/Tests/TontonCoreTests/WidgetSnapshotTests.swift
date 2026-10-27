import XCTest

@testable import TontonCore

final class WidgetSnapshotTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func session(_ id: String, _ status: SessionStatus, minutesAgo: Double = 0, project: String = "api") -> SessionSummary {
        SessionSummary(
            id: id, machineId: "m1", machine: "studio", platform: "darwin", cwd: "/Users/me/secret-client/\(project)",
            project: project, title: "Rotate the keys", status: status, statusText: "Claude needs your permission to use Bash",
            agentOnline: true, canChat: true, pendingPermissions: [], costUSD: 1.5, startedAt: now.addingTimeInterval(-3600),
            lastActivity: now.addingTimeInterval(-minutesAgo * 60), lastMessage: "The password is hunter2")
    }

    func testWhatNeedsTheUserComesFirst() {
        let snapshot = WidgetSnapshot(
            [
                session("done", .idle, minutesAgo: 1), session("old", .ended, minutesAgo: 0),
                session("busy", .working, minutesAgo: 5), session("asks", .permission, minutesAgo: 30),
                session("waits", .waiting, minutesAgo: 2), session("new", .starting, minutesAgo: 1),
            ], previous: nil)
        XCTAssertEqual(snapshot.sessions.map(\.id), ["waits", "asks", "new", "busy", "done", "old"])
        XCTAssertTrue(snapshot.running)
        XCTAssertEqual(snapshot.needYou, 2)
        XCTAssertEqual(snapshot.working, 2)
        XCTAssertEqual(snapshot.done, 1)
    }

    func testTheListIsCutButNotTheCounts() {
        let many = (0..<30).map { session("s\($0)", .working, minutesAgo: Double($0)) }
        let snapshot = WidgetSnapshot(many, previous: nil)
        XCTAssertEqual(snapshot.sessions.count, WidgetSnapshot.limit)
        XCTAssertEqual(snapshot.sessions.first?.id, "s0")
        XCTAssertEqual(snapshot.working, 30)
    }

    func testASessionKeepsWhenItGotIntoItsState() {
        let first = WidgetSnapshot([session("a", .working, minutesAgo: 10)], previous: nil)
        XCTAssertEqual(first.sessions.first?.since, now.addingTimeInterval(-600))
        // Still working, with newer activity: still working since ten minutes ago.
        let same = WidgetSnapshot([session("a", .working, minutesAgo: 0)], previous: first)
        XCTAssertEqual(same.sessions.first?.since, now.addingTimeInterval(-600))
        // Now waiting: since its last activity.
        let changed = WidgetSnapshot([session("a", .waiting, minutesAgo: 1)], previous: same)
        XCTAssertEqual(changed.sessions.first?.since, now.addingTimeInterval(-60))
    }

    func testOnlyWhatTheWidgetDrawsCallsForAReload() {
        let first = WidgetSnapshot([session("a", .working, minutesAgo: 10)], previous: nil)
        XCTAssertTrue(first.differs(from: nil))
        XCTAssertFalse(WidgetSnapshot([session("a", .working, minutesAgo: 0)], previous: nil).differs(from: first))
        XCTAssertTrue(WidgetSnapshot([session("a", .waiting)], previous: first).differs(from: first))
        XCTAssertTrue(WidgetSnapshot([session("a", .working, project: "web")], previous: first).differs(from: first))
        XCTAssertTrue(WidgetSnapshot([], previous: first).differs(from: first))
        XCTAssertTrue(WidgetSnapshot.stopped.differs(from: WidgetSnapshot([], previous: nil)))
    }

    /// The file sits outside the app: conversations, prompts, status texts and folders must never reach it.
    func testTheFileHoldsNothingButWhatTheWidgetDraws() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let share = WidgetShare(file: directory.appendingPathComponent("widget.json"))
        let snapshot = WidgetSnapshot([session("a", .permission, minutesAgo: 3)], previous: nil)
        try share.save(snapshot)

        XCTAssertEqual(share.load(), snapshot)
        let text = try String(contentsOf: share.file, encoding: .utf8)
        for secret in ["hunter2", "secret-client", "Rotate the keys", "permission to use", "Bash", "1.5"] {
            XCTAssertFalse(text.contains(secret), "\(secret) leaked into the widget's file")
        }
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: share.file)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["running", "sessions", "needYou", "working", "done"])
        let row = try XCTUnwrap((json["sessions"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(row.keys), ["id", "project", "machine", "status", "since"])
        let permissions = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: share.file.path)[.posixPermissions] as? Int)
        XCTAssertEqual(permissions, 0o600)
    }

    func testAMissingOrForeignFileReadsAsNothing() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let share = WidgetShare(file: directory.appendingPathComponent("widget.json"))
        XCTAssertNil(share.load())
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(#"{"running":true}"#.utf8).write(to: share.file)
        XCTAssertNil(share.load())
    }

    func testABundleWithoutTheWidgetSharesNothing() {
        XCTAssertNil(WidgetShare(bundle: Bundle(for: WidgetSnapshotTests.self)))
    }

    func testSessionLinks() throws {
        let link = try XCTUnwrap(WidgetSnapshot.link(to: "3f2a-91"))
        XCTAssertEqual(link.absoluteString, "tonton://session/3f2a-91")
        XCTAssertEqual(WidgetSnapshot.sessionId(in: link), "3f2a-91")
        let odd = try XCTUnwrap(WidgetSnapshot.link(to: "a/b c"))
        XCTAssertEqual(WidgetSnapshot.sessionId(in: odd), "a/b c")
        XCTAssertNil(WidgetSnapshot.link(to: ""))
        XCTAssertNil(WidgetSnapshot.sessionId(in: try XCTUnwrap(URL(string: "tonton://session"))))
        XCTAssertNil(WidgetSnapshot.sessionId(in: try XCTUnwrap(URL(string: "tonton://session/"))))
        XCTAssertNil(WidgetSnapshot.sessionId(in: try XCTUnwrap(URL(string: "tonton://open/abc"))))
        XCTAssertNil(WidgetSnapshot.sessionId(in: try XCTUnwrap(URL(string: "https://session/abc"))))
    }
}
