import XCTest

@testable import TontonCore
@testable import TontonMac

/// The background tasks of a session read from this Mac's files (see BackgroundTasksTests for the transcript lines).
final class LocalBackgroundTasksTests: XCTestCase {
    private let now = Date()

    private func line(_ content: Any) throws -> String {
        let timestamp = ISO8601DateFormatter().string(from: now.addingTimeInterval(-60))
        let object: [String: Any] = ["type": "user", "timestamp": timestamp, "message": ["role": "user", "content": content]]
        return String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    private func shell(_ id: String) throws -> String {
        try line([
            [
                "type": "tool_result", "tool_use_id": "toolu_1",
                "content": "Command running in background with ID: \(id). Output is being written to: /tmp/\(id).output. "
                    + "You will be notified when it completes.",
            ]
        ])
    }

    private func notification(_ id: String, _ status: String) throws -> String {
        try line("<task-notification>\n<task-id>\(id)</task-id>\n<status>\(status)</status>\n<summary>Done</summary>\n</task-notification>")
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
