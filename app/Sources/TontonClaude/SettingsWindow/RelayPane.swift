import AppKit
import SwiftUI
import TontonCore

struct RelayPane: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore

    var body: some View {
        if let account = settings.account { AccountView(account: account) } else { SetupView() }
    }
}

struct SetupView: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @State private var selfHosted = false
    @State private var customURL = ""
    @State private var recovery = ""
    @State private var busy = false
    @State private var error: String?

    private var relay: String { selfHosted ? customURL : AppSettings.defaultRelay }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            GroupLabel(text: "Relay").padding(.top, -26)
            Card {
                RelayChoice(title: "Tonton Claude relay", detail: "tonton.d3l.tech · hosted, end-to-end encrypted", selected: !selfHosted) {
                    selfHosted = false
                }
                Hairline()
                RelayChoice(title: "Self-hosted", detail: "Run your own relay and point the app to it", selected: selfHosted) {
                    selfHosted = true
                }
                if selfHosted {
                    ThemeField(placeholder: "https://relay.example.com", text: $customURL).padding(.horizontal, 16).padding(.bottom, 14)
                }
            }
            GroupLabel(text: "New here")
            Card {
                Row(title: "Create an account", detail: "Generates your encryption key on this Mac. The relay never sees it.") {
                    Button("Create account") { run { try await store.createAccount(on: relay) } }
                        .buttonStyle(ThemeButtonStyle(primary: true))
                        .disabled(busy || (selfHosted && URL(string: customURL)?.host == nil))
                }
            }
            GroupLabel(text: "Already have an account")
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Paste the recovery key from your other Mac (Settings › Relay).").font(.system(size: 12)).foregroundStyle(
                        Theme.textDim)
                    HStack(spacing: 6) {
                        ThemeField(placeholder: "tonton1.…", text: $recovery, secure: true)
                        Button("Restore") {
                            guard let account = Account(recoveryKey: recovery) else {
                                error = "This is not a valid recovery key."
                                return
                            }
                            run { try await store.restore(account) }
                        }
                        .buttonStyle(ThemeButtonStyle())
                        .disabled(busy || recovery.isEmpty)
                    }
                }
                .padding(16)
            }
            if let error {
                Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger).padding(.top, 12)
            }
        }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do { try await work() } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

struct RelayChoice: View {
    let title: String
    let detail: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                ZStack {
                    Circle().stroke(selected ? Theme.accent : Theme.borderStrong, lineWidth: 1.5).frame(width: 16, height: 16)
                    if selected { Circle().fill(Theme.accent).frame(width: 8, height: 8) }
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 13, weight: .medium))
                    Text(detail).font(.system(size: 12)).foregroundStyle(Theme.textDim)
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct AccountView: View {
    let account: Account
    @EnvironmentObject var store: SessionStore
    @State private var reveal = false
    @State private var copied = false
    @State private var confirmDelete = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Card {
                Row(title: "Status") {
                    HStack(spacing: 7) {
                        Circle().fill(store.connection == .connected ? Theme.success : Theme.danger).frame(width: 7, height: 7)
                        Text(statusText).font(.system(size: 12)).foregroundStyle(Theme.textDim).lineLimit(1)
                    }
                }
                Hairline()
                Row(title: "Relay") {
                    Text(URL(string: account.relay)?.host ?? account.relay).font(Theme.mono).foregroundStyle(Theme.textDim)
                }
                if let latency = store.latency {
                    Hairline()
                    Row(
                        title: "Latency",
                        detail: latency.level == .high
                            ? "High: approvals and replies will feel slow. A relay closer to you or your machines helps." : nil
                    ) {
                        HStack(spacing: 7) {
                            Circle().fill(latency.level.color).frame(width: 7, height: 7)
                            Text(latency.label).font(Theme.mono).foregroundStyle(Theme.textDim)
                        }
                    }
                }
                Hairline()
                Row(title: "Account") { Text(account.accountId).font(Theme.mono).foregroundStyle(Theme.textDim).textSelection(.enabled) }
                Hairline()
                Row(title: "Encryption", detail: "AES-256-GCM, end to end. The relay only stores sealed data.") {
                    Image(systemName: "lock.fill").font(.system(size: 12)).foregroundStyle(Theme.success)
                }
            }
            GroupLabel(text: "Recovery key")
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    Text(
                        "Use it to sign in on another Mac. Anyone who has it can read and drive your sessions: keep it in your password manager."
                    )
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        Text(reveal ? account.recoveryKey : String(repeating: "•", count: 32))
                            .font(Theme.mono)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                            .padding(.horizontal, 10)
                            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 7).fill(Color.black.opacity(0.35)))
                            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.borderStrong))
                        Button {
                            reveal.toggle()
                        } label: {
                            Image(systemName: reveal ? "eye.slash" : "eye").frame(width: 14)
                        }
                        .buttonStyle(ThemeButtonStyle())
                        Button(copied ? "Copied" : "Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(account.recoveryKey, forType: .string)
                            copied = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                        }
                        .buttonStyle(ThemeButtonStyle())
                    }
                }
                .padding(16)
            }
            HStack(spacing: 8) {
                if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger) }
                Spacer()
                Button("Sign out") { store.signOut() }.buttonStyle(ThemeButtonStyle())
                Button("Delete account…") { confirmDelete = true }.buttonStyle(ThemeButtonStyle())
            }
            .padding(.top, 20)
        }
        .confirmationDialog("Delete your account?", isPresented: $confirmDelete) {
            Button("Delete account", role: .destructive) {
                Task {
                    do { try await store.deleteAccount() } catch { self.error = error.localizedDescription }
                }
            }
        } message: {
            Text("All machines are signed out and the relay forgets everything about this account. This cannot be undone.")
        }
    }

    private var statusText: String {
        switch store.connection {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .paused: "Paused"
        case .notConfigured: "Not set up"
        case .failed(let why): why
        }
    }
}

extension RelayLatency.Level {
    fileprivate var color: Color {
        switch self {
        case .good: Theme.success
        case .fair: Theme.warning
        case .high: Theme.danger
        }
    }
}
