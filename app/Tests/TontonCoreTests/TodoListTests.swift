import CryptoKit
import XCTest

@testable import TontonCore

/// The same cases as agent/test/parser.test.ts and shared/test/todos.test.ts.
final class TodoListTests: XCTestCase {
    private let ts = "2026-10-25T10:00:00Z"

    private func todoWrite(_ id: String, _ states: [TodoItem.Status]) -> Entry {
        Entry(
            id: id, ts: ts, kind: .tool, toolUseId: id, name: "TodoWrite", summary: "Updated the task list",
            todos: states.enumerated().map { TodoItem(content: "task \($0.offset)", status: $0.element) })
    }

    func testATodoWriteCallInATranscriptCarriesItsList() throws {
        let todos: [[String: Any]] = [
            ["content": "Read the code", "status": "completed", "activeForm": "Reading the code"],
            ["content": "Fix the bug", "status": "in_progress", "activeForm": "Fixing the bug"],
            ["content": "Run the tests", "status": "pending", "activeForm": ""],
        ]
        let content: [[String: Any]] = [["type": "tool_use", "id": "t1", "name": "TodoWrite", "input": ["todos": todos]]]
        let fields: [String: Any] = ["type": "assistant", "message": ["content": content], "uuid": "u1", "timestamp": ts]
        let line = String(decoding: try JSONSerialization.data(withJSONObject: fields), as: UTF8.self)
        let entry = try XCTUnwrap(Transcript.parse(line).entries.first)
        XCTAssertEqual(entry.summary, "Updated the task list")
        XCTAssertEqual(
            entry.todos,
            [
                TodoItem(content: "Read the code", status: .completed, activeForm: "Reading the code"),
                TodoItem(content: "Fix the bug", status: .inProgress, activeForm: "Fixing the bug"),
                TodoItem(content: "Run the tests", status: .pending),
            ])
    }

    func testOpenCodesListReadsTheSame() {
        let input: [String: Any] = [
            "todos": [
                ["id": "1", "content": " Ship it ", "status": "cancelled", "priority": "high"],
                ["id": "2", "content": "Later", "status": "someday"],
                ["id": "3", "content": "   ", "status": "pending"],
                ["id": "4", "status": "pending"],
            ]
        ]
        XCTAssertEqual(
            TodoList.items("TodoWrite", input),
            [TodoItem(content: "Ship it", status: .cancelled), TodoItem(content: "Later", status: .pending)])
        let many = ["todos": (0..<80).map { ["content": "t\($0)", "status": "pending"] }]
        XCTAssertEqual(TodoList.items("TodoWrite", many)?.count, 50)
        XCTAssertEqual(
            TodoList.items("TodoWrite", ["todos": [["content": String(repeating: "a", count: 400), "status": "pending"]]])?.first?.content
                .count, 301)
        XCTAssertNil(TodoList.items("TodoWrite", [:]))
        XCTAssertNil(TodoList.items("Bash", input))
    }

    func testTheLiveListIsTheLastOneAndLeavesTheConversation() {
        let entries = [
            Entry(id: "u1", ts: ts, kind: .user, text: "Fix it"),
            todoWrite("t1", [.pending, .pending]),
            Entry(id: "t1:result", ts: ts, kind: .toolResult, text: "ok", toolUseId: "t1", isError: false),
            todoWrite("t2", [.completed, .inProgress]),
            // From an older agent: no list, so it stays a row.
            Entry(id: "t3", ts: ts, kind: .tool, toolUseId: "t3", name: "TodoWrite", summary: "Updated the task list"),
        ]
        XCTAssertEqual(TodoList.latest(in: entries)?.map(\.state), [.completed, .inProgress])
        XCTAssertEqual(ChatItem.build(from: entries).map(\.id), ["u1", "t3"])
        XCTAssertNil(TodoList.latest(in: []))
    }

    func testProgressCountsWhatIsDoneAndStopsOnceAllIsDone() {
        let todos = { (states: [TodoItem.Status]) in self.todoWrite("t", states).todos }
        XCTAssertEqual(TodoList.progress(todos([.completed, .inProgress, .pending, .cancelled])), TaskProgress(done: 1, total: 3))
        XCTAssertNil(TodoList.progress(todos([.completed, .cancelled])))
        XCTAssertNil(TodoList.progress(todos([])))
        XCTAssertNil(TodoList.progress(nil))
    }

    func testAStatusThisAppDoesNotKnowReadsAsPending() throws {
        let json = #"{"id":"t","ts":"x","kind":"tool","name":"TodoWrite","todos":[{"content":"a","status":"someday"}]}"#
        let entry = try JSONDecoder().decode(Entry.self, from: Data(json.utf8))
        XCTAssertEqual(entry.todos?.first?.state, .pending)
    }

    func testProgressComesWithTheMeta() throws {
        let key = SymmetricKey(size: .bits256)
        let meta = try E2E.seal(["tasks": ["done": 1, "total": 4]], with: key)
        let wire = WireSession(
            id: "s1", machineId: "m1", status: .working, agentOnline: true, canChat: true, info: nil, meta: meta, statusDetail: nil,
            pendingPermissions: [], startedAt: ts, lastActivity: ts)
        XCTAssertEqual(SessionVault(key: key).session(wire, machines: []).tasks, TaskProgress(done: 1, total: 4))
    }

    func testALongListShowsWhatRuns() {
        let states: [TodoItem.Status] = Array(repeating: .completed, count: 10) + [.inProgress] + Array(repeating: .pending, count: 9)
        let todos = todoWrite("t", states).todos ?? []
        let window = TodoList.window(todos, limit: 8)
        XCTAssertEqual([window.before, window.shown.count, window.after], [9, 8, 3])
        XCTAssertEqual(window.shown.dropFirst().first?.state, .inProgress)
        XCTAssertEqual(TodoList.window(Array(todos.prefix(5)), limit: 8).shown.count, 5)
        // All done: the end of the list.
        let done = todoWrite("t", Array(repeating: .completed, count: 12)).todos ?? []
        XCTAssertEqual([TodoList.window(done, limit: 8).before, TodoList.window(done, limit: 8).after], [4, 0])
    }
}
