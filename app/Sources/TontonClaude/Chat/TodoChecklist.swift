import SwiftUI
import TontonCore

/// Claude's latest task list as a checklist above the composer, in place of a TodoWrite row per update. Folded, it shows
/// the task that runs; open, every task. Hidden while the conversation has no list.
struct TodoChecklist: View {
    let todos: [TodoItem]
    @State private var open = true

    var body: some View {
        let progress = TodoList.progress(todos)
        let done = todos.filter { $0.state == .completed }.count
        let counted = todos.filter { $0.state != .cancelled }.count
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "checklist").font(.system(size: 10)).foregroundStyle(Theme.accent)
                    Text("Tasks").font(.system(size: 11, weight: .semibold))
                    Text(progress == nil ? "All done" : "\(done)/\(counted)").font(.system(size: 10)).foregroundStyle(.secondary)
                        .monospacedDigit()
                    if !open, let running = todos.first(where: { $0.state == .inProgress }) {
                        Text(running.activeForm ?? running.content).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9)).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(progress.map { "Tasks, \($0.done) of \($0.total) done" } ?? "Tasks, all done")
            if open {
                let window = TodoList.window(todos, limit: Self.rows)
                VStack(alignment: .leading, spacing: 3) {
                    if window.before > 0 { more(window.before, done: true) }
                    ForEach(Array(window.shown.enumerated()), id: \.offset) { _, todo in row(todo) }
                    if window.after > 0 { more(window.after, done: false) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.raised))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.border))
        // A finished list starts folded: there is nothing left to follow.
        .onAppear { open = progress != nil }
        .onChange(of: progress == nil) { _, finished in if finished { open = false } }
    }

    /// Enough to follow along without pushing the conversation away.
    private static let rows = 8

    private func more(_ count: Int, done: Bool) -> some View {
        Text(done ? "\(count) done" : "\(count) more").font(.system(size: 10)).foregroundStyle(.tertiary).padding(.leading, 18)
    }

    private func row(_ todo: TodoItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon(todo.state))
                .font(.system(size: 10))
                .foregroundStyle(color(todo.state))
                .frame(width: 12)
            Text(todo.state == .inProgress ? todo.activeForm ?? todo.content : todo.content)
                .font(.system(size: 11, weight: todo.state == .inProgress ? .semibold : .regular))
                .strikethrough(todo.state == .completed || todo.state == .cancelled, color: .secondary)
                .foregroundStyle(todo.state == .pending || todo.state == .inProgress ? Theme.text : Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(label(todo.state))
    }

    private func icon(_ state: TodoItem.Status) -> String {
        switch state {
        case .completed: "checkmark.circle.fill"
        case .inProgress: "circle.dotted.circle"
        case .cancelled: "xmark.circle"
        case .pending: "circle"
        }
    }

    private func color(_ state: TodoItem.Status) -> Color {
        switch state {
        case .completed: Theme.success
        case .inProgress: Theme.accent
        case .cancelled, .pending: Theme.textFaint
        }
    }

    private func label(_ state: TodoItem.Status) -> String {
        switch state {
        case .completed: "done"
        case .inProgress: "in progress"
        case .cancelled: "cancelled"
        case .pending: "to do"
        }
    }
}

/// "3/7" in a session row, while its task list has unfinished tasks.
struct TaskProgressBadge: View {
    let progress: TaskProgress

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "checklist").font(.system(size: 8))
            Text("\(progress.done)/\(progress.total)").font(.system(size: 9, weight: .medium)).monospacedDigit()
        }
        .foregroundStyle(.secondary)
        .help("Tasks done in Claude's list")
        .accessibilityLabel("\(progress.done) of \(progress.total) tasks done")
    }
}
