import Foundation

/// Claude's task list (TodoWrite in Claude Code, todowrite in OpenCode): the latest list of a conversation is the live
/// one, shown as a checklist, and its progress shows in the session row. Mirrors shared/todos.ts.
public enum TodoList {
    /// The list the conversation's last TodoWrite set. Nil when it has none, or only from agents that do not send it.
    public static func latest(in entries: [Entry]) -> [TodoItem]? {
        entries.last { $0.isTodoList }?.todos
    }

    /// Completed tasks out of those not cancelled. Nil for an empty list, or once every task is done.
    public static func progress(_ todos: [TodoItem]?) -> TaskProgress? {
        guard let todos else { return nil }
        let counted = todos.filter { $0.state != .cancelled }
        let done = counted.filter { $0.state == .completed }.count
        return !counted.isEmpty && done < counted.count ? TaskProgress(done: done, total: counted.count) : nil
    }

    /// The tasks a checklist of `limit` rows shows: from the one before the first unfinished task, so what runs is in view,
    /// with how many are left out before and after.
    public static func window(_ todos: [TodoItem], limit: Int) -> (shown: ArraySlice<TodoItem>, before: Int, after: Int) {
        guard todos.count > limit else { return (todos[...], 0, 0) }
        let firstOpen = todos.firstIndex { $0.state == .pending || $0.state == .inProgress } ?? todos.count
        let start = min(max(firstOpen - 1, 0), todos.count - limit)
        return (todos[start..<start + limit], start, todos.count - start - limit)
    }

    /// The task list a TodoWrite call sets, as the agent reads it (agent/src/transcript/parser.ts): Claude Code's
    /// `{ todos: [{ content, status, activeForm }] }` and OpenCode's `{ todos: [{ content, status, priority, id }] }`.
    static func items(_ name: String, _ input: Any?) -> [TodoItem]? {
        guard name == "TodoWrite", let todos = (input as? [String: Any])?["todos"] as? [Any] else { return nil }
        func cut(_ text: String) -> String {
            text.utf16.count > maxChars ? "\(String(decoding: Array(text.utf16.prefix(maxChars)), as: UTF16.self))…" : text
        }
        return todos.compactMap { todo -> TodoItem? in
            guard let fields = todo as? [String: Any], let content = fields["content"] as? String,
                !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            let active = (fields["activeForm"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return TodoItem(
                content: cut(content.trimmingCharacters(in: .whitespacesAndNewlines)),
                status: TodoItem.Status(rawValue: fields["status"] as? String ?? "") ?? .pending,
                activeForm: active.flatMap { $0.isEmpty ? nil : cut($0) })
        }
        .prefix(maxItems).map { $0 }
    }

    static let maxItems = 50
    static let maxChars = 300
}

/// How far a session's task list is: tasks completed, out of those not cancelled.
public struct TaskProgress: Codable, Equatable, Sendable {
    public let done: Int
    public let total: Int

    public init(done: Int, total: Int) {
        self.done = done
        self.total = total
    }
}
