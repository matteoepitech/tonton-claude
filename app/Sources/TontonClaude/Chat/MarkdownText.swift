import AppKit
import SwiftUI
import TontonCore

/// Lightweight markdown: inline styles via AttributedString; headings, fenced code blocks and tables split out by
/// MarkdownBlock.
struct MarkdownText: View {
    let text: String
    /// The open notch's by default; What's new, outside the notch, keeps the Default size.
    var textSize = Theme.textSize

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let s):
                    Text(Self.inline(s)).font(.system(size: textSize.points(12))).textSelection(.enabled)
                case .code(let s):
                    CodeBlock(code: s, textSize: textSize)
                case .table(let table):
                    MarkdownTableView(table: table, textSize: textSize)
                }
            }
        }
    }

    static func inline(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
    }
}

/// A fenced code block that scrolls sideways, with a copy button on hover.
struct CodeBlock: View {
    let code: String
    let textSize: NotchTextSize
    @State private var hovering = false
    @State private var copied = false

    var body: some View {
        ScrollView(.horizontal) {
            Text(code).font(.system(size: textSize.points(11), design: .monospaced)).textSelection(.enabled).padding(8)
        }
        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ink.opacity(0.07)))
        .overlay(alignment: .topTrailing) {
            if hovering || copied {
                Button(action: copy) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: textSize.points(10), weight: .medium))
                        .frame(width: 22, height: 22)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Theme.borderStrong))
                }
                .buttonStyle(.plain)
                .foregroundStyle(copied ? Theme.success : Theme.textDim)
                .help("Copy")
                .accessibilityLabel(copied ? "Copied" : "Copy the code")
                .padding(4)
            }
        }
        .onHover { hovering = $0 }
        // The button only shows under the pointer.
        .accessibilityAction(named: "Copy the code") { copy() }
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }
}

/// A table sized to its content, with long cells wrapping when it is wider than the chat: semibold header, hairlines
/// between rows, inside a rounded frame like the code blocks.
struct MarkdownTableView: View {
    let table: MarkdownTable
    let textSize: NotchTextSize

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(table.header.enumerated()), id: \.offset) { column, name in
                    cell(name, column: column, header: true).gridColumnAlignment(alignment(column).horizontal)
                }
            }
            Rectangle().fill(Theme.borderStrong).frame(height: 1).gridCellUnsizedAxes(.horizontal)
            ForEach(Array(table.rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Rectangle().fill(Theme.border).frame(height: 1).gridCellUnsizedAxes(.horizontal) }
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { column, value in cell(value, column: column) }
                }
            }
        }
        .textSelection(.enabled)
        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ink.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.border))
    }

    private func alignment(_ column: Int) -> MarkdownTable.Alignment {
        column < table.alignments.count ? table.alignments[column] : .leading
    }

    private func cell(_ value: String, column: Int, header: Bool = false) -> some View {
        Text(MarkdownText.inline(value))
            .font(.system(size: textSize.points(11.5), weight: header ? .semibold : .regular))
            .multilineTextAlignment(alignment(column).text)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
    }
}

extension MarkdownTable.Alignment {
    fileprivate var horizontal: HorizontalAlignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    fileprivate var text: TextAlignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}
