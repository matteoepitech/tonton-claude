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
                .font(.notch(10))
                .foregroundStyle(Theme.tertiary)
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
                        .font(.notch(12))
                        .textSelection(.enabled)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .foregroundStyle(Theme.onAccent)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.accent.opacity(pending ? 0.35 : 0.8)))
                }
                if viaNotch || pending {
                    Text(pending ? "sending…" : "from the notch").font(.notch(9)).foregroundStyle(Theme.tertiary)
                }
            }
        }
    }
}

struct ImageStrip: View {
    let images: [ImageData]
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var state: NotchState

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(images.enumerated()), id: \.offset) { index, img in
                if let ns = ImageCache.shared.image(for: img) {
                    Image(nsImage: ns)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: 220, maxHeight: 150)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .quickLook({ preview(at: index) }, state: state)
                }
            }
        }
    }

    /// Every image of the message, so the arrows go from one to the next.
    private func preview(at index: Int) {
        let items = images.enumerated().map { offset, img in
            let ext = img.mediaType.split(separator: "/").last.map(String.init) ?? "png"
            return QuickLook.Item(name: "image-\(offset + 1).\(ext)", data: Data(base64Encoded: img.data) ?? Data())
        }
        if let failure = QuickLook.shared.show(items, at: index) { store.lastError = failure }
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
                Image(systemName: icon).font(.notch(10)).frame(width: 14)
                Text(call.name ?? "?").font(.notch(11, weight: .semibold))
                Text(call.summary ?? "").font(.notch(11, design: .monospaced)).foregroundStyle(Theme.secondary).lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if let path = call.filePath, FileManager.default.fileExists(atPath: path) {
                    let editor = settings.editor.available
                    Button {
                        editor.open(path)
                    } label: {
                        Image(systemName: "arrow.up.forward.square").font(.notch(10))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.secondary)
                    .help(editor == .defaultApp ? "Open" : "Open in \(editor.label)")
                }
                if running {
                    ProgressView().controlSize(.mini)
                } else if result?.isError == true {
                    Image(systemName: "xmark.circle.fill").font(.notch(10)).foregroundStyle(.red)
                } else if result != nil {
                    Image(systemName: "checkmark").font(.notch(9)).foregroundStyle(Theme.tertiary)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { if result != nil { open.toggle() } }
            if let edits = call.edits, !edits.isEmpty { EditDiff(edits: edits, path: call.summary) }
            if open, let result {
                if let imgs = result.images, !imgs.isEmpty { ImageStrip(images: imgs) }
                ScrollView {
                    Text(result.text ?? "")
                        .font(.notch(10, design: .monospaced))
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
