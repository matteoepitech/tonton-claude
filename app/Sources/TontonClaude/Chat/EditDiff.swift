import SwiftUI
import TontonCore

/// The replacements of an Edit or MultiEdit call as a red and green diff, with light syntax colours. Long diffs fold to
/// their first lines.
struct EditDiff: View {
    let edits: [FileEdit]
    /// The edited file, for the colours of its language.
    let path: String?
    @State private var expanded = false

    private static let foldedLines = 10

    var body: some View {
        let fileExtension = (path.map { URL(fileURLWithPath: $0).pathExtension }) ?? ""
        let hunks = edits.map { LineDiff.lines(old: $0.oldText, new: $0.newText) }
        let total = hunks.map(\.count).reduce(0, +) + max(0, hunks.count - 1)
        let shown = expanded ? hunks : Self.fold(hunks, to: Self.foldedLines)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.offset) { index, lines in
                if index > 0 { Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 2) }
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in row(line, fileExtension: fileExtension) }
            }
            if total > Self.foldedLines {
                Button(expanded ? "Show less" : "Show all \(total) lines") { expanded.toggle() }
                    .buttonStyle(.plain)
                    .font(.notch(10, weight: .medium))
                    .foregroundStyle(Theme.accent)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
            }
        }
        .padding(.vertical, 4)
        .textSelection(.enabled)
        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ink.opacity(0.04)))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func row(_ line: LineDiff.Line, fileExtension: String) -> some View {
        let (mark, tint): (String, Color?) =
            switch line.kind {
            case .removed: ("−", Color(nsColor: .systemRed))
            case .added: ("+", Color(nsColor: .systemGreen))
            case .same: (" ", nil)
            }
        return HStack(alignment: .top, spacing: 6) {
            Text(mark).foregroundStyle(tint ?? .secondary).frame(width: 8)
            Text(Self.highlighted(line.text, fileExtension: fileExtension)).frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.notch(10, design: .monospaced))
        .padding(.horizontal, 6)
        .padding(.vertical, 0.5)
        .background(tint.map { $0.opacity(0.14) } ?? .clear)
    }

    /// The first lines of the hunks, in order, up to `limit`.
    static func fold(_ hunks: [[LineDiff.Line]], to limit: Int) -> [[LineDiff.Line]] {
        var left = limit
        return hunks.compactMap { lines in
            guard left > 0 else { return nil }
            defer { left -= lines.count }
            return Array(lines.prefix(left))
        }
    }

    private static func highlighted(_ text: String, fileExtension: String) -> AttributedString {
        var result = AttributedString()
        for (piece, token) in Syntax.tokens(text, fileExtension: fileExtension) {
            var run = AttributedString(piece)
            switch token {
            case .keyword: run.foregroundColor = Color(nsColor: .systemPink)
            case .string: run.foregroundColor = Color(nsColor: .systemOrange)
            case .comment: run.foregroundColor = Theme.textFaint
            case .number: run.foregroundColor = Color(nsColor: .systemTeal)
            case .plain: run.foregroundColor = Theme.text.opacity(0.85)
            }
            result += run
        }
        return result
    }
}
