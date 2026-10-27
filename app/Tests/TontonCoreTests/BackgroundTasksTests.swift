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

    /// A notification that arrived while Claude worked: Claude Code queues it as an attachment, not as a message.
    func testANotificationQueuedWhileClaudeWorkedEndsTheTaskToo() throws {
        let notification = "<task-notification>\n<task-id>bi8o5pw7k</task-id>\n<status>completed</status>\n</task-notification>"
        let json = { (object: [String: Any]) in String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self) }
        var queued = BackgroundTasks()
        try queued.read(shell("bi8o5pw7k"), now: now)
        try queued.read(
            json([
                "type": "attachment", "timestamp": ISO8601DateFormatter().string(from: now),
                "attachment": ["type": "queued_command", "prompt": notification, "commandMode": "task-notification"],
            ]), now: now)
        XCTAssertEqual(queued.count(at: now), 0)
        var enqueued = BackgroundTasks()
        try enqueued.read(shell("bi8o5pw7k"), now: now)
        try enqueued.read(json(["type": "queue-operation", "operation": "enqueue", "content": notification]), now: now)
        XCTAssertEqual(enqueued.count(at: now), 0)
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
}
