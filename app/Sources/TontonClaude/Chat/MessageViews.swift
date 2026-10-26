import AppKit
import SwiftUI
import TontonCore

struct ChatItemView: View {
    let item: ChatItem
    let sessionWorking: Bool

    var body: some View {
        switch item {
        case .user(let e):
            UserBubble(text: e.text ?? "", images: e.images ?? [], viaNotch: e.viaNotch == true)
        case .assistant(let e):
            MarkdownText(text: e.text ?? "").frame(maxWidth: .infinity, alignment: .leading)
        case .tool(let call, let result):
            ToolRow(call: call, result: result, running: result == nil && sessionWorking)
        case .system(let e):
            Text(e.text ?? "")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
        }
    }
}

struct UserBubble: View {
    let text: String
    let images: [ImageData]
    var viaNotch = false
    var pending = false

    var body: some View {
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 4) {
                if !images.isEmpty { ImageStrip(images: images) }
                if !text.isEmpty {
                    Text(text)
                        .font(.system(size: 12))
                        .textSelection(.enabled)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .foregroundStyle(Theme.onAccent)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.accent.opacity(pending ? 0.35 : 0.8)))
                }
                if viaNotch || pending {
                    Text(pending ? "sending…" : "from the notch").font(.system(size: 9)).foregroundStyle(.tertiary)
                }
            }
        }
    }
}

struct ImageStrip: View {
    let images: [ImageData]
    @EnvironmentObject var store: SessionStore

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(images.enumerated()), id: \.offset) { _, img in
                if let ns = ImageCache.shared.image(for: img) {
                    Image(nsImage: ns)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: 220, maxHeight: 150)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .onTapGesture { openInPreview(img) }
                        .help("Open in Preview")
                }
            }
        }
    }

    private func openInPreview(_ img: ImageData) {
        guard let data = Data(base64Encoded: img.data) else { return }
        let ext = img.mediaType.split(separator: "/").last.map(String.init) ?? "png"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tonton-\(UUID().uuidString).\(ext)")
        if let failure = SaveFailure.write(data, to: url) {
            store.lastError = failure
            return
        }
        NSWorkspace.shared.open(url)
    }
}

struct ToolRow: View {
    let call: Entry
    let result: Entry?
    let running: Bool
    @EnvironmentObject var settings: AppSettings
    @State private var open = false

    private var icon: String {
        switch call.name ?? "" {
        case "Bash", "PowerShell": "terminal"
        case "Read": "doc.text"
        case "Write", "Edit", "MultiEdit", "NotebookEdit": "pencil"
        case "Grep", "Glob": "magnifyingglass"
        case "WebFetch", "WebSearch": "globe"
        case "Agent", "Task": "person.2"
        case "TodoWrite": "checklist"
        default: "wrench.and.screwdriver"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 10)).frame(width: 14)
                Text(call.name ?? "?").font(.system(size: 11, weight: .semibold))
                Text(call.summary ?? "").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if let path = call.filePath, FileManager.default.fileExists(atPath: path) {
                    let editor = settings.editor.available
                    Button {
                        editor.open(path)
                    } label: {
                        Image(systemName: "arrow.up.forward.square").font(.system(size: 10))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help(editor == .defaultApp ? "Open" : "Open in \(editor.label)")
                }
                if running {
                    ProgressView().controlSize(.mini)
                } else if result?.isError == true {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 10)).foregroundStyle(.red)
                } else if result != nil {
                    Image(systemName: "checkmark").font(.system(size: 9)).foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { if result != nil { open.toggle() } }
            if let edits = call.edits, !edits.isEmpty { EditDiff(edits: edits, path: call.summary) }
            if open, let result {
                if let imgs = result.images, !imgs.isEmpty { ImageStrip(images: imgs) }
                ScrollView {
                    Text(result.text ?? "")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(result.isError == true ? .red : .secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 180)
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ink.opacity(0.05)))
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.ink.opacity(0.05)))
    }
}
