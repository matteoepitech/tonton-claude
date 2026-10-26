import XCTest

@testable import TontonCore

/// The same transcript lines as agent/test/background.test.ts.
final class BackgroundTasksTests: XCTestCase {
    private let now = Date()

    private func line(_ content: Any, minutesAgo: Double = 1) throws -> String {
        let timestamp = ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutesAgo * 60))
        let object: [String: Any] = ["type": "user", "timestamp": timestamp, "message": ["role": "user", "content": content]]
        return String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    private func shell(_ id: String, minutesAgo: Double = 1) throws -> String {
        try line(
            [
                [
                    "type": "tool_result", "tool_use_id": "toolu_1",
                    "content": "Command running in background with ID: \(id). Output is being written to: /tmp/\(id).output. "
                        + "You will be notified when it completes.",
                ]
            ], minutesAgo: minutesAgo)
    }

    private func notification(_ id: String, _ status: String) throws -> String {
        try line("<task-notification>\n<task-id>\(id)</task-id>\n<status>\(status)</status>\n<summary>Done</summary>\n</task-notification>")
    }

    func testTasksRunUntilTheyReportBack() throws {
        var tasks = BackgroundTasks()
        try tasks.read(shell("bi8o5pw7k"), now: now)
        let agent: [[String: Any]] = [
            [
                "type": "tool_result", "tool_use_id": "toolu_2",
                "content": [
                    [
                        "type": "text",
                        "text": "Async agent launched successfully.\nagentId: ab249dac865b63e60\nYou will be notified when it completes.",
                    ]
                ],
            ]
        ]
        try tasks.read(line(agent), now: now)
        XCTAssertEqual(tasks.count(at: now), 2)
        XCTAssertEqual(tasks.waiting(at: now), "Waiting for 2 background tasks")
        try tasks.read(notification("bi8o5pw7k", "completed"), now: now)
        try tasks.read(
            line([["type": "tool_result", "tool_use_id": "t", "content": "Successfully stopped task: ab249dac865b63e60"]]), now: now)
        XCTAssertEqual(tasks.count(at: now), 0)
        XCTAssertNil(tasks.waiting(at: now))
    }

    func testOldTasksAndJunkDoNotCount() throws {
        var tasks = BackgroundTasks()
        try tasks.read(shell("old1234", minutesAgo: 3 * 60), now: now)
        tasks.read("not json", now: now)
        try tasks.read(line([["type": "tool_result", "tool_use_id": "t", "content": "ok (build complete)"]]), now: now)
        XCTAssertEqual(tasks.count(at: now), 0)
    }

    func testThisMacsSessionStaysAtWorkWhileATaskRuns() throws {
        var conversation = LocalSessions.Conversation()
        conversation.apply(TranscriptTail.Read(lines: [try shell("bi8o5pw7k")]))
        // Claude Code's registry says the session is done with its turn.
        let record = LocalSessions.Record(pid: 1, sessionId: "s1", cwd: "/x", status: "idle")
        let session = LocalSessions.summary(record, conversation)
        XCTAssertEqual(session.status, .working)
        XCTAssertEqual(session.statusText, "Waiting for 1 background task")
        conversation.apply(TranscriptTail.Read(lines: [try notification("bi8o5pw7k", "completed")]))
        XCTAssertEqual(LocalSessions.summary(record, conversation).status, .idle)
        // A closed session is closed, whatever ran in its background.
        conversation.apply(TranscriptTail.Read(lines: [try shell("b5iig1z64")]))
        XCTAssertEqual(LocalSessions.summary(record, conversation, endedAt: now).status, .ended)
    }
}
