import AppKit
import SwiftUI
import TontonCore

/// The header's button for the files the session changed, with how many. Hidden until Claude changed one.
struct ChangedFilesButton: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var state: NotchState

    var body: some View {
        let count = ChangedFiles.list(store.entries[session.id] ?? []).count
        if count > 0 {
            let open = state.filesOf == session.id
            Button {
                state.filesOf = open ? nil : session.id
            } label: {
                HStack(spacing: 2) {
                    Image(systemName: "doc.text").font(.notch(11))
                    Text("\(count)").font(.notch(10, weight: .semibold)).monospacedDigit()
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(open ? Theme.accent : .secondary)
            .help(open ? "Back to the conversation" : "Files changed in this session")
            .accessibilityLabel("\(count) files changed")
        }
    }
}

/// Over the conversation while the files button is on: each file Claude changed, the most recent first, its diffs one
/// click away, and a way to open it when the session runs on this Mac.
struct ChangedFilesPanel: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var state: NotchState
    @State private var expanded: Set<String> = []

    var body: some View {
        if state.filesOf == session.id {
            let files = ChangedFiles.list(store.entries[session.id] ?? [])
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Files changed").font(.notch(12, weight: .semibold))
                    Text("\(files.count)").font(.notch(11)).foregroundStyle(.secondary).monospacedDigit()
                    Spacer()
                    Button {
                        state.filesOf = nil
                    } label: {
                        Image(systemName: "xmark").font(.notch(10, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help("Back to the conversation")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                Rectangle().fill(Theme.border).frame(height: 1)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(files) { file in
                            ChangedFileRow(
                                file: file, cwd: session.cwd, local: store.isOnThisMac(session),
                                expanded: Binding(
                                    get: { expanded.contains(file.id) },
                                    set: { if $0 { expanded.insert(file.id) } else { expanded.remove(file.id) } }))
                        }
                        if files.isEmpty {
                            Text("Claude has not changed any file in this session.").font(.notch(11)).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .scrollIndicators(.never)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Theme.bg)
        }
    }
}

struct ChangedFileRow: View {
    let file: ChangedFile
    let cwd: String
    /// The session runs on this Mac: its files can be opened here.
    let local: Bool
    @Binding var expanded: Bool
    @EnvironmentObject var settings: AppSettings

    private var hasDetails: Bool { !file.edits.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: hasDetails ? (expanded ? "chevron.down" : "chevron.right") : "circle.fill")
                    .font(.notch(hasDetails ? 8 : 4, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 10)
                Image(systemName: file.written && file.edits.isEmpty ? "doc.badge.plus" : "pencil").font(.notch(10)).frame(width: 14)
                VStack(alignment: .leading, spacing: 1) {
                    Text(file.name).font(.notch(11, weight: .semibold)).lineLimit(1)
                    let shown = file.shownPath(in: cwd)
                    if shown != file.name {
                        Text(shown).font(.notch(10, design: .monospaced)).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer(minLength: 4)
                Text(summary).font(.notch(10)).foregroundStyle(.secondary).fixedSize()
                if file.lastFailed {
                    Image(systemName: "exclamationmark.triangle.fill").font(.notch(10)).foregroundStyle(Theme.warning)
                        .help("The last change to this file failed")
                }
                if local, FileManager.default.fileExists(atPath: file.path) {
                    let editor = settings.editor.available
                    Button {
                        editor.open(file.path)
                    } label: {
                        Image(systemName: "arrow.up.forward.square").font(.notch(10))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help(editor == .defaultApp ? "Open" : "Open in \(editor.label)")
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { if hasDetails { expanded.toggle() } }
            if expanded && hasDetails { EditDiff(edits: file.edits, path: file.path).padding(.leading, 16) }
        }
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.raised))
    }

    private var summary: String {
        if file.changes == 0 { return "failed" }
        let changes = "\(file.changes) change\(file.changes == 1 ? "" : "s")"
        return file.written && file.edits.isEmpty ? "written · \(changes)" : changes
    }
}
