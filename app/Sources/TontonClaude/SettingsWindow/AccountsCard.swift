import SwiftUI
import TontonCore

/// The accounts signed in on this Mac: rename them, switch to one, or add another. One is connected at a time.
struct AccountsCard: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    /// Nil when there is nowhere to add one from (the setup is already showing).
    var add: (() -> Void)?

    var body: some View {
        Card {
            ForEach(Array(settings.accounts.sorted.enumerated()), id: \.element.id) { index, entry in
                if index > 0 { Hairline() }
                AccountRow(entry: entry, connected: settings.account.map(AccountList.id(of:)) == entry.id)
            }
            if let add {
                if !settings.accounts.entries.isEmpty { Hairline() }
                HStack {
                    Text("Keep a work and a personal account on this Mac and switch between them.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Add an account…", action: add).buttonStyle(ThemeButtonStyle())
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        }
    }
}

private struct AccountRow: View {
    let entry: AccountList.Entry
    let connected: Bool
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @State private var name = ""
    @State private var confirmRemove = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: connected ? "person.crop.circle.fill.badge.checkmark" : "person.crop.circle")
                .font(.system(size: 16))
                .foregroundStyle(connected ? Theme.success : Theme.textDim)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                TextField("Name", text: $name)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13, weight: .medium))
                    .onSubmit { settings.accounts.rename(entry.account, to: name) }
                Text("\(URL(string: entry.account.relay)?.host ?? entry.account.relay) · \(entry.account.accountId)")
                    .font(Theme.mono)
                    .foregroundStyle(Theme.textFaint)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 12)
            if connected {
                Text("Connected").font(.system(size: 12)).foregroundStyle(Theme.textDim)
            } else {
                Button("Remove…") { confirmRemove = true }.buttonStyle(ThemeButtonStyle())
                Button("Switch") { store.switchAccount(to: entry.account) }.buttonStyle(ThemeButtonStyle())
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .confirmationDialog("Remove \(entry.name) from this Mac?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) { store.signOut(of: entry.account) }
        } message: {
            Text("Its keys leave this Mac. The account stays on the relay: its recovery key adds it back.")
        }
        .onAppear { name = entry.name }
        .onChange(of: entry.name) { name = $1 }
        // A name left half typed is kept when the pane changes.
        .onDisappear { if name != entry.name { settings.accounts.rename(entry.account, to: name) } }
    }
}
