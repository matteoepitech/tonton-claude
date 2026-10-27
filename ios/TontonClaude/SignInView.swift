import SwiftUI
import TontonCore

/// The phone joins the account of the Mac: scan the QR code in Settings › Relay with the Camera, or paste the recovery
/// key. Nothing is created here, since the key that opens the sessions lives on the Mac.
struct SignInView: View {
    @Environment(PhoneStore.self) private var store
    @State private var key = ""
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        PixelMascot(status: .waiting).frame(width: 56, height: 56)
                        Text("Your Claude Code sessions, in your pocket.").font(.title2.bold())
                        Text("Follow every session of your machines, answer them and approve what they ask, end to end encrypted.")
                            .foregroundStyle(.secondary)
                    }
                    step(
                        1, "On your Mac, open Tonton Claude › Settings › Relay.",
                        detail: "The phone signs in to the same account. Set one up on the Mac first if you have none.")
                    step(
                        2, "Scan the QR code under Recovery key with the Camera.",
                        detail: "It opens this app and signs in. Or copy the recovery key and paste it below.")
                    VStack(alignment: .leading, spacing: 10) {
                        SecureField("tonton1.…", text: $key)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.body.monospaced())
                            .padding(12)
                            .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground)))
                        HStack {
                            PasteButton(payloadType: String.self) { strings in
                                if let first = strings.first { Task { @MainActor in key = first } }
                            }
                            .labelStyle(.titleAndIcon)
                            Spacer()
                            Button {
                                signIn()
                            } label: {
                                if busy { ProgressView() } else { Text("Sign in").bold() }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(key.isEmpty || busy)
                        }
                        if let problem {
                            Text(problem).font(.footnote).foregroundStyle(.red)
                        }
                    }
                    Text("Whoever has the recovery key can read and drive your sessions. The phone keeps it in its Keychain.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(24)
            }
            .navigationTitle("Tonton Claude")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func step(_ number: Int, _ title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.subheadline.bold())
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.tonton.opacity(0.2)))
                .foregroundStyle(Color.tonton)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.weight(.semibold))
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    private func signIn() {
        guard let account = Account(signInLink: key) else {
            problem = "This is not a recovery key. It starts with tonton1."
            return
        }
        busy = true
        problem = nil
        Task {
            do {
                try await store.signIn(account)
            } catch {
                problem = error.localizedDescription
            }
            busy = false
        }
    }
}
