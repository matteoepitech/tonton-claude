import XCTest

@testable import TontonCore
@testable import TontonMac

/// The task list's progress of this Mac's OpenCode 2 sessions, read without the agent (see TodoListTests).
final class LocalTodoListTests: XCTestCase {
    func testOpenCodeSessionsOnThisMacShowTheirProgress() throws {
        let listed = try XCTUnwrap(OpenCodeLocal.listed(["id": "ses_1", "location": ["directory": "/x"], "time": ["created": 1]]))
        var conversation = OpenCodeLocal.Conversation()
        let todos = [TodoItem(content: "a", status: .completed), TodoItem(content: "b", status: .pending)]
        conversation.entries = [
            Entry(id: "t1", ts: "2026-10-27T10:00:00Z", kind: .tool, toolUseId: "t1", name: "TodoWrite", summary: "", todos: todos)
        ]
        XCTAssertEqual(OpenCodeLocal.summary(listed, conversation, permissions: []).tasks, TaskProgress(done: 1, total: 2))
    }
}
