import SwiftUI
import TontonCore
import UIKit

/// One element of the conversation: the user's messages on the right, Claude's answers in markdown, tool calls folded.
struct ChatItemRow: View {
    let item: ChatItem
    let working: Bool

    var body: some View {
        switch item {
        case .user(let entry):
            UserBubble(entry: entry)
        case .assistant(let entry):
            MarkdownView(text: entry.text ?? "").frame(maxWidth: .infinity, alignment: .leading)
        case .tool(let call, let result):
            ToolRow(call: call, result: result, running: result == nil && working)
        case .system(let entry):
            Text(entry.text ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
    }
}

struct UserBubble: View {
    let entry: Entry

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 4) {
                if let images = entry.images, !images.isEmpty { ImageStrip(images: images) }
                if let text = entry.text, !text.isEmpty {
                    Text(text)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .foregroundStyle(.white)
                        .background(RoundedRectangle(cornerRadius: 18).fill(Color.accentColor))
                }
                if entry.viaNotch == true {
                    Text("from Tonton Claude").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }
}

struct ToolRow: View {
    let call: Entry
    let result: Entry?
    let running: Bool
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
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if result != nil { withAnimation(.snappy) { open.toggle() } }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: icon).font(.caption).frame(width: 16)
                    Text(call.name ?? "Tool").font(.caption.weight(.semibold))
                    Text(call.summary ?? "")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    if running {
                        ProgressView().controlSize(.mini)
                    } else if result?.isError == true {
                        Image(systemName: "xmark.circle.fill").font(.caption).foregroundStyle(.red)
                    } else if result != nil {
                        Image(systemName: open ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open, let result {
                if let images = result.images, !images.isEmpty { ImageStrip(images: images) }
                ScrollView {
                    Text(result.text ?? "")
                        .font(.caption2.monospaced())
                        .foregroundStyle(result.isError == true ? .red : .secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 220)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
    }
}

struct ImageStrip: View {
    let images: [ImageData]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(images.enumerated()), id: \.offset) { _, image in
                    if let picture = ImageCache.image(for: image) {
                        Image(uiImage: picture)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: 220, maxHeight: 160)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
        }
    }
}

/// Decoding base64 images on every redraw would stall scrolling.
@MainActor
enum ImageCache {
    private static let cache = NSCache<NSString, UIImage>()

    static func image(for image: ImageData) -> UIImage? {
        let key = "\(image.data.count)-\(image.data.prefix(64))-\(image.data.suffix(64))" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let data = Data(base64Encoded: image.data), let decoded = UIImage(data: data) else { return nil }
        cache.setObject(decoded, forKey: key)
        return decoded
    }
}

/// Inline styles through AttributedString; headings, fenced code and tables split out by `MarkdownBlock`, as on the Mac.
struct MarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let prose):
                    Text(Self.inline(prose)).textSelection(.enabled)
                case .code(let code):
                    CodeBlockView(code: code)
                case .table(let table):
                    ScrollView(.horizontal, showsIndicators: false) { TableView(table: table) }
                }
            }
        }
    }

    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

struct CodeBlockView: View {
    let code: String
    @State private var copied = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code).font(.caption.monospaced()).textSelection(.enabled).padding(10)
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.07)))
        .overlay(alignment: .topTrailing) {
            Button {
                UIPasteboard.general.string = code
                copied = true
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption2).padding(8)
            }
            .accessibilityLabel("Copy")
        }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

struct TableView: View {
    let table: MarkdownTable

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(table.header.enumerated()), id: \.offset) { _, name in cell(name, header: true) }
            }
            Divider()
            ForEach(Array(table.rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Divider().opacity(0.5) }
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, value in cell(value) }
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.1)))
    }

    private func cell(_ value: String, header: Bool = false) -> some View {
        Text(MarkdownView.inline(value))
            .font(.caption.weight(header ? .semibold : .regular))
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
    }
}
