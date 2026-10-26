import XCTest

@testable import TontonCore

final class LocalSessionsTests: XCTestCase {
    private var home: URL!

    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent("claude-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("sessions"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: home.appendingPathComponent("projects/-Users-del-app"), withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: home) }

    private func write(_ text: String, to path: String) throws {
        try Data(text.utf8).write(to: home.appendingPathComponent(path))
    }

    func testRunningSessionsComeFromTheRegistryOfLiveProcesses() throws {
        try write(#"{"pid":10,"sessionId":"s1","cwd":"/Users/del/app","status":"busy","startedAt":1793005151072}"#, to: "sessions/10.json")
        try write(#"{"pid":11,"sessionId":"s2","cwd":"/tmp","status":"idle"}"#, to: "sessions/11.json")
        try write(#"{"peerToken":"secret"}"#, to: "sessions/10.abc.key")
        try write("not json", to: "sessions/12.json")
        let running = LocalSessions.running(in: home) { $0 == 10 }
        XCTAssertEqual(running.map(\.sessionId), ["s1"])
        XCTAssertEqual(running.first?.startedAt, 1_793_005_151_072)
    }

    func testTranscriptsAreFoundInAnyProjectDirectory() throws {
        try write("", to: "projects/-Users-del-app/s1.jsonl")
        XCTAssertEqual(LocalSessions.transcript(of: "s1", in: home)?.lastPathComponent, "s1.jsonl")
        XCTAssertNil(LocalSessions.transcript(of: "s2", in: home))
    }

    func testOnlyAWaitForAPermissionAsksForAttention() {
        func status(_ status: String?, _ waitingFor: String? = nil) -> SessionStatus {
            LocalSessions.Record(pid: 1, sessionId: "s", cwd: "/", status: status, waitingFor: waitingFor).sessionStatus
        }
        XCTAssertEqual(status("busy"), .working)
        XCTAssertEqual(status("waiting", "input needed"), .idle)
        XCTAssertEqual(status("waiting", "Permission to run Bash"), .permission)
        XCTAssertEqual(status("idle"), .idle)
        XCTAssertEqual(status(nil), .idle)
    }

    func testTheSessionAsTheNotchShowsIt() {
        var conversation = LocalSessions.Conversation()
        conversation.apply(
            TranscriptTail.Read(lines: [
                #"{"type":"user","uuid":"u1","timestamp":"t","message":{"content":"Fix the build"}}"#,
                #"{"type":"ai-title","aiTitle":"Fix the build"}"#, #"{"type":"cost-state","totalCostUSD":0.5}"#,
            ]))
        let record = LocalSessions.Record(pid: 1, sessionId: "s1", cwd: "/Users/del/app/", status: "busy", startedAt: 0, updatedAt: 1000)
        let session = LocalSessions.summary(record, conversation)
        XCTAssertEqual(session.machineId, LocalSessions.machineId)
        XCTAssertEqual(session.project, "app")
        XCTAssertEqual(session.cwd, "/Users/del/app")
        XCTAssertEqual(session.status, .working)
        XCTAssertEqual(session.title, "Fix the build")
        XCTAssertEqual(session.costUSD, 0.5)
        XCTAssertEqual(session.lastMessage, "Fix the build")
        XCTAssertFalse(session.canChat)
        XCTAssertEqual(session.lastActivity, Date(timeIntervalSince1970: 1))

        let ended = LocalSessions.summary(record, conversation, endedAt: Date(timeIntervalSince1970: 5))
        XCTAssertEqual(ended.status, .ended)
        XCTAssertEqual(ended.lastActivity, Date(timeIntervalSince1970: 5))
    }

    func testTheConversationKeepsTheLatestEntriesAndStartsOverOnAReset() {
        var conversation = LocalSessions.Conversation()
        let lines = (0..<450).map { #"{"type":"user","uuid":"u\#($0)","timestamp":"t","message":{"content":"m\#($0)"}}"# }
        conversation.apply(TranscriptTail.Read(lines: lines))
        XCTAssertEqual(conversation.entries.count, LocalSessions.maxEntries)
        XCTAssertEqual(conversation.entries.last?.text, "m449")
        conversation.apply(TranscriptTail.Read(lines: [lines[0]], reset: true))
        XCTAssertEqual(conversation.entries.map(\.text), ["m0"])
    }
}
