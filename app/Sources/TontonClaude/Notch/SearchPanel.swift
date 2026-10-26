import SwiftUI
import TontonCore

/// ⌘F in the open notch: every conversation the app holds, searched as you type. ↩ opens the message.
struct SearchPanel: View {
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var store: SessionStore
    @State private var query = ""
    @State private var selection = 0
    @FocusState private var focused: Bool

    private static let shown = 8

    var body: some View {
        let hits = Array(ConversationSearch.search(query, in: store.entries).prefix(Self.shown))
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "text.magnifyingglass").foregroundStyle(.secondary)
                TextField("", text: $query, prompt: Text("Search every conversation").foregroundStyle(.white.opacity(0.35)))
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused($focused)
                    .onSubmit { if hits.indices.contains(selection) { open(hits[selection]) } }
                    .onKeyPress(.downArrow) {
                        selection = min(selection + 1, max(hits.count - 1, 0))
                        return .handled
                    }
                    .onKeyPress(.upArrow) {
                        selection = max(selection - 1, 0)
                        return .handled
                    }
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            if !hits.isEmpty { Rectangle().fill(Theme.border).frame(height: 1) }
            ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                let session = store.sessions.first { $0.id == hit.sessionId }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(session?.project ?? "Session").font(.system(size: 12, weight: .semibold)).lineLimit(1)
                        Text(session?.machine ?? "").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                        Text(Self.label(hit.kind)).font(.system(size: 10)).foregroundStyle(.tertiary)
                    }
                    Text(hit.snippet).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(index == selection ? Color.white.opacity(0.1) : .clear)
                .contentShape(Rectangle())
                .onTapGesture { open(hit) }
            }
            if hits.isEmpty && !query.trimmingCharacters(in: .whitespaces).isEmpty {
                Text("No message matches").font(.system(size: 12)).foregroundStyle(.secondary).frame(height: 40)
            }
        }
        .frame(width: 480)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.09)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.borderStrong))
        .shadow(color: .black.opacity(0.5), radius: 20, y: 8)
        .onAppear { focused = true }
        .onChange(of: query) { _, _ in selection = 0 }
    }

    private func open(_ hit: ConversationSearch.Hit) {
        state.showSearch = false
        state.scrollTarget = hit.itemId
        store.selectedId = hit.sessionId
    }

    private static func label(_ kind: EntryKind) -> String {
        switch kind {
        case .user: "You"
        case .assistant: "Claude"
        case .tool, .toolResult: "Tool"
        case .system: "Session"
        }
    }
}
