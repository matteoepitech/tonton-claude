import XCTest

@testable import TontonCore
@testable import TontonMac

/// This Mac's Codex sessions, read from a Codex home made in a temporary folder: never the developer's own ~/.codex.
final class CodexLocalTests: XCTestCase {
    private var home = URL(fileURLWithPath: "/nonexistent")

    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent("codex-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("sessions"), withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: home) }

    private func meta(_ id: String, extra: String = "") -> String {
        #"{"timestamp":"2026-11-04T10:00:00.000Z","type":"session_meta","payload":{"id":"\#(id)","session_id":"\#(id)","cwd":"/work/hero/","git":{"branch":"main"}\#(extra)}}"#
    }

    /// A rollout in the day folder of `date`, written to at `modified`.
    @discardableResult
    private func rollout(_ name: String, on date: Date, modified: Date, _ text: String) throws -> URL {
        let day = Calendar.current.dateComponents([.year, .month, .day], from: date)
        let folder = home.appendingPathComponent(
            String(format: "sessions/%04d/%02d/%02d", day.year ?? 0, day.month ?? 0, day.day ?? 0), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent(name)
        try Data(text.utf8).write(to: file)
        try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: file.path)
        return file
    }

    func testTheHomeIsCodexHomeElseDotCodex() {
        let user = URL(fileURLWithPath: "/Users/del")
        XCTAssertEqual(CodexLocal.home(environment: ["CODEX_HOME": "/tmp/codex"], user: user).path, "/tmp/codex")
        XCTAssertEqual(CodexLocal.home(environment: [:], user: user).path, "/Users/del/.codex")
        let file = URL(fileURLWithPath: "/tmp/codex/sessions/2026/11/04/rollout-a.jsonl")
        XCTAssertEqual(CodexLocal.home(ofRollout: file)?.path, "/tmp/codex")
        XCTAssertNil(CodexLocal.home(ofRollout: URL(fileURLWithPath: "/tmp/elsewhere/rollout-a.jsonl")))
    }

    func testRecentPlainRolloutsOfTheDayFolders() throws {
        let now = Date()
        let recent = try rollout("rollout-2026-11-04T10-00-00-a.jsonl", on: now, modified: now, meta("a") + "\n")
        try rollout("rollout-2026-11-04T09-00-00-b.jsonl", on: now, modified: now.addingTimeInterval(-2 * CodexLocal.recent), meta("b"))
        // A week old, compressed: macOS has nothing to read it with.
        try rollout("rollout-2026-11-04T08-00-00-c.jsonl.zst", on: now, modified: now, "")
        try rollout("notes.txt", on: now, modified: now, "")
        let found = CodexLocal.rollouts(
            in: home.appendingPathComponent("sessions"), since: now.addingTimeInterval(-CodexLocal.recent), now: now)
        XCTAssertEqual(found.map(\.lastPathComponent), [recent.lastPathComponent])
    }

    func testTheSessionIsReadFromTheFirstLineOnly() throws {
        let now = Date()
        let file = try rollout("rollout-a.jsonl", on: now, modified: now, meta("a"))
        // Codex has not written the whole line yet.
        XCTAssertEqual(CodexLocal.firstLine(of: file), .notYet)
        try Data((meta("a") + "\n" + String(repeating: "x", count: 100) + "\n").utf8).write(to: file)
        guard case .session(let session) = CodexLocal.firstLine(of: file) else { return XCTFail("no session") }
        XCTAssertEqual(session.sessionId, "a")
        XCTAssertEqual(session.branch, "main")
        try Data("{\"type\":\"event_msg\",\"payload\":{}}\n".utf8).write(to: file)
        XCTAssertEqual(CodexLocal.firstLine(of: file), .other)
        // Longer than any session_meta: not read again and again.
        try Data(String(repeating: "x", count: CodexLocal.firstLineBytes + 1).utf8).write(to: file)
        XCTAssertEqual(CodexLocal.firstLine(of: file), .other)
    }

    func testThreadNamesComeFromTheHomesIndex() throws {
        try Data(#"{"id":"a","thread_name":"Fix the build"}"#.utf8).write(to: home.appendingPathComponent("session_index.jsonl"))
        XCTAssertEqual(CodexLocal.threadNames(in: home), ["a": "Fix the build"])
        XCTAssertEqual(CodexLocal.threadNames(in: home.appendingPathComponent("none")), [:])
    }

    /// Codex keeps a thread's rollout open while the thread lives: the files a process has open say which sessions run.
    func testTheFilesAProcessHasOpenAreFound() throws {
        let file = try rollout("rollout-open.jsonl", on: Date(), modified: Date(), meta("a") + "\n")
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let open = CodexLocal.openFiles(of: getpid())
        XCTAssertTrue(open.contains(CodexLocal.realPath(file.path)), "\(open)")
        XCTAssertTrue(CodexLocal.isRollout(file.path))
        XCTAssertFalse(CodexLocal.isRollout(file.path + ".zst"))
        XCTAssertNotNil(CodexLocal.processes())
        XCTAssertFalse(CodexLocal.name(of: getpid()).isEmpty)
    }

    func testTheSessionAsTheNotchShowsIt() throws {
        let session = try XCTUnwrap(CodexRollout.session(meta("a")))
        var conversation = CodexConversation()
        conversation.apply(
            TranscriptTail.Read(lines: [
                #"{"timestamp":"2026-11-04T10:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#,
                #"{"timestamp":"2026-11-04T10:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"Fix the build"}}"#,
            ]))
        let modified = Date(timeIntervalSince1970: 1_793_786_500)
        let live = CodexLocal.summary(session, conversation, name: nil, live: true, modified: modified)
        XCTAssertEqual(live.id, "a")
        XCTAssertEqual(live.machineId, LocalSessions.machineId)
        XCTAssertEqual(live.cwd, "/work/hero")
        XCTAssertEqual(live.project, "hero")
        XCTAssertEqual(live.status, .working)
        XCTAssertEqual(live.title, "Fix the build")
        XCTAssertEqual(live.lastMessage, "Fix the build")
        XCTAssertEqual(live.codingTool, .codex)
        XCTAssertEqual(live.branch, "main")
        XCTAssertFalse(live.canChat)
        XCTAssertEqual(live.lastActivity, modified)
        XCTAssertEqual(live.startedAt, ISO8601.parse("2026-11-04T10:00:00.000Z"))
        // The name the user gave the thread wins over the first prompt.
        XCTAssertEqual(CodexLocal.summary(session, conversation, name: "Build", live: true, modified: modified).title, "Build")
        // No process has the rollout open: Codex is gone, whatever its last turn said.
        XCTAssertEqual(CodexLocal.summary(session, conversation, name: nil, live: false, modified: modified).status, .ended)
        // Not known: the rollout's turns say.
        XCTAssertEqual(CodexLocal.summary(session, conversation, name: nil, live: nil, modified: modified).status, .working)
    }
}
