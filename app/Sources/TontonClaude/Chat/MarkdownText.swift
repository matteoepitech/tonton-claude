import SwiftUI
import TontonCore

/// Lightweight markdown: inline styles via AttributedString; headings, fenced code blocks and tables split out by
/// MarkdownBlock.
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let s):
                    Text(Self.inline(s)).font(.system(size: 12)).textSelection(.enabled)
                case .code(let s):
                    ScrollView(.horizontal) {
                        Text(s).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).padding(8)
                    }
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.07)))
                case .table(let table):
                    MarkdownTableView(table: table)
                }
            }
        }
    }

    static func inline(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
    }
}

/// A table sized to its content, with long cells wrapping when it is wider than the chat: semibold header, hairlines
/// between rows, inside a rounded frame like the code blocks.
struct MarkdownTableView: View {
    let table: MarkdownTable

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
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.border))
    }

    private func alignment(_ column: Int) -> MarkdownTable.Alignment {
        column < table.alignments.count ? table.alignments[column] : .leading
    }

    private func cell(_ value: String, column: Int, header: Bool = false) -> some View {
        Text(MarkdownText.inline(value))
            .font(.system(size: 11.5, weight: header ? .semibold : .regular))
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
