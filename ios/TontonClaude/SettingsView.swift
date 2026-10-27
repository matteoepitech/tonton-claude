import SwiftUI
import TontonCore
import UIKit
import UserNotifications

struct SettingsView: View {
    @Environment(PhoneStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var confirmSignOut = false

    var body: some View {
        @Bindable var push = store.push
        @Bindable var island = store.island
        NavigationStack {
            Form {
                if let account = store.account {
                    Section("Account") {
                        LabeledContent("Relay", value: URL(string: account.relay)?.host() ?? account.relay)
                        LabeledContent("Status") { ConnectionText(state: store.connection) }
                        LabeledContent("Encryption", value: "AES-256-GCM, end to end")
                    }
                }
                Section {
                    Toggle("Permission requests", isOn: $push.alertsEnabled)
                    if push.authorization == .denied {
                        Button("Allow notifications in Settings") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                        }
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    Text(notificationsFooter)
                }
                Section {
                    Toggle("Live Activity", isOn: $island.enabled)
                } footer: {
                    Text(
                        island.available
                            ? "The sessions on the Lock Screen and in the Dynamic Island while something runs."
                            : "Live Activities are turned off for Tonton Claude in the Settings app.")
                }
                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                } footer: {
                    Text("The phone forgets the account. Your Mac and your machines keep it.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Sign out of this account?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    Task {
                        await store.signOut()
                        dismiss()
                    }
                }
            }
            .task { await store.push.refreshAuthorization() }
        }
    }

    private var notificationsFooter: String {
        switch store.push.relayPushes {
        case .some(true): "An alert for each request, readable only on this phone: Apple and the relay only carry it sealed."
        case .some(false): "This relay does not send notifications: requests show while the app is open."
        case .none: "Requests show while the app is open, and as alerts once the relay confirms it sends them."
        }
    }
}

struct ConnectionText: View {
    let state: ConnectionState

    var body: some View {
        switch state {
        case .connected: Text("Connected").foregroundStyle(.green)
        case .connecting: Text("Connecting…").foregroundStyle(.secondary)
        case .paused: Text("Paused").foregroundStyle(.secondary)
        case .notConfigured: Text("Not set up").foregroundStyle(.secondary)
        case .failed(let why): Text(why).foregroundStyle(.orange)
        }
    }
}
