import SwiftUI
import TontonCore

struct SessionListView: View {
    @Environment(PhoneStore.self) private var store
    @State private var settingsShown = false

    var body: some View {
        @Bindable var store = store
        NavigationStack(path: $store.path) {
            List {
                if store.connection != .connected {
                    Section { ConnectionBanner(state: store.connection).font(.subheadline) }
                }
                ForEach(SessionGroup.groups(store.feed.sessions)) { group in
                    Section(group.kind.title) {
                        ForEach(group.sessions) { session in
                            NavigationLink(value: session.id) { SessionRow(session: session) }
                                .swipeActions {
                                    if !session.status.isLive {
                                        Button("Remove", role: .destructive) { store.dismiss(session.id) }
                                    }
                                }
                        }
                    }
                }
            }
            .overlay {
                if store.feed.sessions.isEmpty && store.connection == .connected {
                    ContentUnavailableView(
                        "No sessions", systemImage: "terminal",
                        description: Text("Start claude on a machine of this account and it shows up here."))
                }
            }
            .refreshable { store.reconnect() }
            .navigationTitle("Sessions")
            .navigationDestination(for: String.self) { id in SessionView(sessionId: id) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        settingsShown = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $settingsShown) { SettingsView() }
        }
    }
}

struct SessionRow: View {
    let session: SessionSummary

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: session.status.symbol)
                .font(.footnote.weight(.bold))
                .foregroundStyle(session.status.tint)
                .frame(width: 30, height: 30)
                .background(Circle().fill(session.status.tint.opacity(0.15)))
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(session.displayName).font(.headline).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(session.lastActivity, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let line = session.title ?? session.lastMessage {
                    Text(line).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 4) {
                    Text(session.machine).foregroundStyle(.secondary)
                    Text("·").foregroundStyle(.tertiary)
                    Text(session.displayStatusText).foregroundStyle(session.status.needsAttention ? session.status.tint : .secondary)
                    if session.pendingPermissions.count > 1 {
                        Text("\(session.pendingPermissions.count)")
                            .font(.caption2.bold())
                            .padding(.horizontal, 6)
                            .background(Capsule().fill(session.status.tint.opacity(0.2)))
                    }
                }
                .font(.caption)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}
