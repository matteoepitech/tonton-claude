import SwiftUI

/// Lightweight markdown: inline styles via AttributedString, fenced code blocks and headings handled by hand.
struct MarkdownText: View {
    let text: String

    enum Block: Hashable { case prose(String), code(String) }

    private var blocks: [Block] {
        var out: [Block] = []
        var prose: [String] = [], code: [String] = []
        var inCode = false
        for line in text.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if inCode {
                    out.append(.code(code.joined(separator: "\n"))); code = []
                } else if !prose.isEmpty {
                    out.append(.prose(prose.joined(separator: "\n"))); prose = []
                }
                inCode.toggle()
            } else if inCode {
                code.append(line)
            } else if let heading = line.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
                prose.append("**\(line[heading.upperBound...])**")
            } else {
                prose.append(line)
            }
        }
        if inCode { out.append(.code(code.joined(separator: "\n"))) }
        if !prose.isEmpty { out.append(.prose(prose.joined(separator: "\n"))) }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let s):
                    Text(attributed(s)).font(.system(size: 12)).textSelection(.enabled)
                case .code(let s):
                    ScrollView(.horizontal) {
                        Text(s).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).padding(8)
                    }
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.07)))
                }
            }
        }
    }

    private func attributed(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
    }
}
