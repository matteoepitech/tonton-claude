import Foundation

/// The blocks of an assistant message. Prose keeps its inline markdown for AttributedString; code blocks and tables are
/// laid out by the chat view.
public enum MarkdownBlock: Equatable, Sendable {
    case prose(String)
    case code(String)
    case table(MarkdownTable)

    public static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.components(separatedBy: "\n")
        var out: [MarkdownBlock] = []
        var prose: [String] = [], code: [String] = []
        var inCode = false
        // Blank lines around a block only add space: the view already separates blocks.
        func flushProse() {
            let s = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !s.isEmpty { out.append(.prose(s)) }
            prose = []
        }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if inCode {
                    out.append(.code(code.joined(separator: "\n"))); code = []
                } else {
                    flushProse()
                }
                inCode.toggle()
            } else if inCode {
                code.append(line)
            } else if i + 1 < lines.count, let table = MarkdownTable(header: line, delimiter: lines[i + 1]) {
                flushProse()
                var table = table
                i += 2
                while i < lines.count, table.append(row: lines[i]) { i += 1 }
                out.append(.table(table))
                continue
            } else if let heading = line.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
                prose.append("**\(line[heading.upperBound...])**")
            } else {
                prose.append(line)
            }
            i += 1
        }
        if inCode { out.append(.code(code.joined(separator: "\n"))) }
        flushProse()
        return out
    }
}

/// A GitHub-flavored table: a header row, a delimiter row that sets each column's alignment, then rows up to the
/// first blank line or line without a pipe. Rows are padded or cut to the header's width. Cells keep their inline
/// markdown; `\|` is a literal pipe.
public struct MarkdownTable: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable { case leading, center, trailing }

    public let header: [String]
    public let alignments: [Alignment]
    public private(set) var rows: [[String]] = []

    init?(header: String, delimiter: String) {
        guard header.contains("|"), delimiter.contains("|") else { return nil }
        let names = Self.cells(header), marks = Self.cells(delimiter)
        guard !names.isEmpty, names.count == marks.count,
            marks.allSatisfy({ $0.range(of: #"^:?-+:?$"#, options: .regularExpression) != nil })
        else { return nil }
        self.header = names
        alignments = marks.map { mark in
            switch (mark.hasPrefix(":"), mark.hasSuffix(":")) {
            case (true, true): .center
            case (false, true): .trailing
            default: .leading
            }
        }
    }

    /// Adds the line as a row, or returns false when it ends the table.
    mutating func append(row line: String) -> Bool {
        guard line.contains("|"), !line.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        let cells = Self.cells(line)
        rows.append((0..<header.count).map { $0 < cells.count ? cells[$0] : "" })
        return true
    }

    private static func cells(_ line: String) -> [String] {
        let line = line.trimmingCharacters(in: .whitespaces)
        var cells: [String] = [], cell = "", escaped = false, endsWithPipe = false
        for char in line {
            endsWithPipe = false
            if escaped {
                cell += char == "|" ? "|" : "\\\(char)"
                escaped = false
            } else if char == "\\" {
                escaped = true
            } else if char == "|" {
                cells.append(cell); cell = ""
                endsWithPipe = true
            } else {
                cell.append(char)
            }
        }
        if escaped { cell += "\\" }
        // The outer pipes are optional: a leading one leaves an empty first cell, a trailing one no last cell.
        if !endsWithPipe { cells.append(cell) }
        if line.hasPrefix("|") { cells.removeFirst() }
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }
}
