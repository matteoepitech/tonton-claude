import SwiftUI
import TontonCore

/// ⌘K in the open notch: find a session, jump to a machine or run an action, from the keyboard alone.
struct CommandPalette: View {
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var store: SessionStore
    @State private var query = ""
    @State private var selection = 0
    @FocusState private var focused: Bool

    private struct Item: Identifiable {
        let id: String
        let icon: String
        let title: String
        let detail: String
        let run: () -> Void
    }

    private static let shown = 8

    var body: some View {
        let items = Array(FuzzyMatch.rank(allItems, query: query) { "\($0.title) \($0.detail)" }.prefix(Self.shown))
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("", text: $query, prompt: Text("Sessions, machines, settings…").foregroundStyle(.white.opacity(0.35)))
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused($focused)
                    .onSubmit { activate(items) }
                    .onKeyPress(.downArrow) {
                        selection = min(selection + 1, max(items.count - 1, 0))
                        return .handled
                    }
                    .onKeyPress(.upArrow) {
                        selection = max(selection - 1, 0)
                        return .handled
                    }
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            if !items.isEmpty { Rectangle().fill(Theme.border).frame(height: 1) }
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                HStack(spacing: 10) {
                    Image(systemName: item.icon).font(.system(size: 12)).frame(width: 18).foregroundStyle(.secondary)
                    Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                    Text(item.detail).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                    if index == selection { Text("↩").font(.system(size: 11)).foregroundStyle(.secondary) }
                }
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(index == selection ? Color.white.opacity(0.1) : .clear)
                .contentShape(Rectangle())
                .onTapGesture { finish(item) }
            }
            if items.isEmpty && !query.isEmpty {
                Text("Nothing matches").font(.system(size: 12)).foregroundStyle(.secondary).frame(height: 40)
            }
        }
        .frame(width: 440)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.09)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.borderStrong))
        .shadow(color: .black.opacity(0.5), radius: 20, y: 8)
        .onAppear { focused = true }
        .onChange(of: query) { _, _ in selection = 0 }
    }

    private var allItems: [Item] {
        let sessions = store.orderedSessions.map { session in
            Item(
                id: "session-\(session.id)", icon: "bubble.left", title: session.project,
                detail: "\(session.machine) · \(session.title ?? session.status.label)"
            ) { store.selectedId = session.id }
        }
        let machines = Dictionary(grouping: store.orderedSessions, by: \.machine).keys.sorted().map { machine in
            Item(id: "machine-\(machine)", icon: "desktopcomputer", title: machine, detail: "Machine") {
                // Its first session in the list, the one ⌘1…9 would pick among its own.
                store.selectedId = store.orderedSessions.first { $0.machine == machine }?.id
            }
        }
        let panes = SettingsPane.allCases.map { pane in
            Item(id: "settings-\(pane.rawValue)", icon: pane.icon, title: "Settings › \(pane.title)", detail: "Open") {
                AppDelegate.shared?.showSettings(pane: pane)
            }
        }
        let pin = Item(
            id: "pin", icon: state.pinned ? "pin.slash" : "pin", title: state.pinned ? "Unpin the notch" : "Pin the notch open",
            detail: "Notch"
        ) {
            state.pinned.toggle()
        }
        return sessions + machines + [pin] + panes
    }

    private func activate(_ items: [Item]) {
        guard items.indices.contains(selection) else { return }
        finish(items[selection])
    }

    private func finish(_ item: Item) {
        state.showPalette = false
        item.run()
    }
}
