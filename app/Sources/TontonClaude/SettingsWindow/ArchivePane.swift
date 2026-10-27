import SwiftUI
import TontonCore

/// Settings › Archive: the finished conversations kept on this Mac, sealed with a key of its own, to read again.
struct ArchivePane: View {
    @ObservedObject var archive: ArchiveStore
    @EnvironmentObject var settings: AppSettings
    @State private var confirmDeleteAll = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Card {
                ToggleRow(
                    title: "Archive finished conversations",
                    detail: """
                        When a session ends, its whole conversation is kept here, sealed with a key of this Mac's. Any session can \
                        also be archived from its menu in the notch, and the notch's search looks here too. Each account has its own.
                        """,
                    isOn: $settings.archiveFinished)
            }
            GroupLabel(text: "Conversations")
            Card {
                if archive.summaries.isEmpty {
                    Text("Nothing archived yet.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
                ForEach(Array(archive.summaries.enumerated()), id: \.element.id) { index, summary in
                    if index > 0 { Hairline() }
                    row(summary)
                }
            }
            if let failure = archive.failure {
                Text(failure).font(.system(size: 12)).foregroundStyle(Theme.danger).padding(.top, 10)
            }
            HStack {
                Text(
                    """
                    Up to \(ConversationArchive.kept) conversations, the most recent ones, on this Mac only. The key sits next to them: \
                    a copy of the archive folder alone can't be read, but anyone who can read your files can.
                    """
                )
                .fixedSize(horizontal: false, vertical: true)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textFaint)
                Spacer()
                if !archive.summaries.isEmpty {
                    Button("Delete all…") { confirmDeleteAll = true }.buttonStyle(ThemeButtonStyle())
                }
            }
            .padding(.top, 16)
        }
        .confirmationDialog("Delete every archived conversation?", isPresented: $confirmDeleteAll) {
            Button("Delete all", role: .destructive) { archive.deleteAll() }
        } message: {
            Text("They can't be brought back.")
        }
    }

    private func row(_ summary: ConversationArchive.Summary) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.title ?? summary.project).font(.system(size: 13, weight: .medium)).lineLimit(1)
                let date = summary.archivedAt.formatted(date: .abbreviated, time: .shortened)
                Text("\(summary.project) · \(summary.machine) · \(date) · \(summary.messages) messages")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textDim)
                    .lineLimit(1)
            }
            Spacer(minLength: 12)
            Button("Open") { if let failure = archive.open(summary.id) { archive.failure = failure } }.buttonStyle(ThemeButtonStyle())
            Button {
                archive.delete(summary.id)
            } label: {
                Image(systemName: "trash").font(.system(size: 11))
            }
            .buttonStyle(ThemeButtonStyle())
            .help("Delete")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}
