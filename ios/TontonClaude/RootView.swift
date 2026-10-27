import SwiftUI
import TontonCore

struct RootView: View {
    @Environment(PhoneStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Group {
            if store.account == nil { SignInView() } else { SessionListView() }
        }
        .alert(
            "Tonton Claude", isPresented: Binding(get: { store.lastError != nil }, set: { if !$0 { store.lastError = nil } }),
            actions: { Button("OK") { store.lastError = nil } }, message: { Text(store.lastError ?? "") })
    }
}

/// What the socket is doing, when it is not simply connected.
struct ConnectionBanner: View {
    let state: ConnectionState

    var body: some View {
        switch state {
        case .connected, .notConfigured:
            EmptyView()
        case .connecting, .paused:
            Label("Connecting to the relay…", systemImage: "antenna.radiowaves.left.and.right").foregroundStyle(.secondary)
        case .failed(let why):
            Label(why, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
    }
}
