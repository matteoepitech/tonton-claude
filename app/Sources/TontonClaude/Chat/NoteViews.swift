import OSLog
import SwiftUI
import TontonCore

/// The notes of every session, on this Mac only (Application Support/Tonton Claude/notes.json). Saved a moment after the
/// last keystroke.
@MainActor
final class NotesStore: ObservableObject {
    static let shared = NotesStore()

    @Published private(set) var notes: SessionNotes
    private let url: URL
    private var pendingSave: Task<Void, Never>?

    init(url: URL = NotesStore.defaultURL) {
        self.url = url
        notes = SessionNotes.load(from: url)
    }

    nonisolated static var defaultURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Tonton Claude/notes.json")
    }

    func binding(for sessionId: String) -> Binding<String> {
        Binding(get: { self.notes.text(for: sessionId) }, set: { self.set($0, for: sessionId) })
    }

    func set(_ text: String, for sessionId: String) {
        notes.set(text, for: sessionId)
        pendingSave?.cancel()
        pendingSave = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled, let self else { return }
            do { try notes.save(to: url) } catch { Logger.app.error("notes: \(error.localizedDescription)") }
        }
    }
}

/// In the chat header: opens the session's note, filled when it has one.
struct NoteButton: View {
    let session: SessionSummary
    @ObservedObject private var store = NotesStore.shared
    @State private var editing = false

    var body: some View {
        let has = store.notes.has(session.id)
        Button {
            editing.toggle()
        } label: {
            Image(systemName: has ? "note.text" : "square.and.pencil").font(.notch(11))
        }
        .buttonStyle(.plain)
        .foregroundStyle(has ? AnyShapeStyle(Theme.accent) : Theme.secondary)
        .help(has ? "Your note on this session" : "Add a note to this session, kept on this Mac")
        .accessibilityLabel(has ? "Edit note" : "Add note")
        .popover(isPresented: $editing, arrowEdge: .bottom) { NoteEditor(text: store.binding(for: session.id)) }
    }
}

/// A few lines, saved as you type.
struct NoteEditor: View {
    @Binding var text: String
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Note").font(.notch(12, weight: .semibold))
                Spacer()
                Text(verbatim: "\(text.count)/\(SessionNotes.maxLength)").font(.notch(10).monospacedDigit()).foregroundStyle(
                    Theme.tertiary)
            }
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text("What to check when Claude is done…").font(.notch(12)).foregroundStyle(Theme.tertiary)
                        .padding(.horizontal, 5).padding(.vertical, 8)
                }
                TextEditor(text: $text)
                    .font(.notch(12))
                    .scrollContentBackground(.hidden)
                    .focused($focused)
            }
            .frame(height: 120)
            .padding(4)
            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.code))
            Text("Kept on this Mac only.").font(.notch(10)).foregroundStyle(Theme.tertiary)
        }
        .padding(12)
        .frame(width: 280)
        .onAppear { focused = true }
    }
}

/// In the session row, when the session has a note.
struct NoteMark: View {
    let sessionId: String
    @ObservedObject private var store = NotesStore.shared

    var body: some View {
        if store.notes.has(sessionId) {
            Image(systemName: "note.text").font(.notch(9)).foregroundStyle(Theme.tertiary)
                .help(store.notes.text(for: sessionId))
                .accessibilityLabel("Has a note")
        }
    }
}
