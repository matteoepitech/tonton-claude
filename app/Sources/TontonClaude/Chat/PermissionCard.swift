import SwiftUI
import TontonCore

struct PermissionCard: View {
    let request: PermissionRequest
    let answer: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "lock.shield").foregroundStyle(Theme.accent)
                Text("Allow \(request.toolName)?").font(.system(size: 12, weight: .bold))
                Spacer()
            }
            Text(request.description).font(.system(size: 11)).foregroundStyle(.secondary)
            if !request.inputPreview.isEmpty {
                Text(request.inputPreview)
                    .font(.system(size: 10, design: .monospaced))
                    .textSelection(.enabled)
                    .lineLimit(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.06)))
            }
            HStack {
                Spacer()
                Button("Deny") { answer(false) }
                Button("Allow") { answer(true) }
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.accent.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.4)))
    }
}
