import Foundation

/// The lines of an edit, as a diff: what was removed, what was added, and what stayed around them.
public enum LineDiff {
    public enum Kind: Equatable, Sendable { case same, removed, added }

    public struct Line: Equatable, Sendable {
        public let kind: Kind
        public let text: String

        public init(_ kind: Kind, _ text: String) {
            self.kind = kind
            self.text = text
        }
    }

    /// Past this many lines on a side, a full comparison costs too much: the old lines are all shown removed, the new added.
    static let maxComparedLines = 400

    /// A longest-common-subsequence diff of the two texts, line by line.
    public static func lines(old: String, new: String) -> [Line] {
        let a = old.isEmpty ? [] : old.components(separatedBy: "\n")
        let b = new.isEmpty ? [] : new.components(separatedBy: "\n")
        guard a.count <= maxComparedLines, b.count <= maxComparedLines else {
            return a.map { Line(.removed, $0) } + b.map { Line(.added, $0) }
        }
        // common[i][j]: the longest run of lines shared by a[i...] and b[j...].
        var common = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                common[i][j] = a[i] == b[j] ? common[i + 1][j + 1] + 1 : max(common[i + 1][j], common[i][j + 1])
            }
        }
        var lines: [Line] = []
        var (i, j) = (0, 0)
        while i < a.count || j < b.count {
            if i < a.count, j < b.count, a[i] == b[j] {
                lines.append(Line(.same, a[i]))
                (i, j) = (i + 1, j + 1)
            } else if j < b.count, i == a.count || common[i][j + 1] >= common[i + 1][j] {
                lines.append(Line(.added, b[j]))
                j += 1
            } else {
                lines.append(Line(.removed, a[i]))
                i += 1
            }
        }
        // Removals read better before the additions that replace them.
        return reorderedChanges(lines)
    }

    /// Within each run of changed lines, puts the removed ones first.
    private static func reorderedChanges(_ lines: [Line]) -> [Line] {
        var result: [Line] = []
        var run: [Line] = []
        func flush() {
            result += run.filter { $0.kind == .removed } + run.filter { $0.kind == .added }
            run = []
        }
        for line in lines {
            if line.kind == .same {
                flush()
                result.append(line)
            } else {
                run.append(line)
            }
        }
        flush()
        return result
    }
}

/// A light syntax colouring for code in diffs: keywords, strings, comments and numbers, the same rules for every language
/// except how a line comment starts.
public enum Syntax {
    public enum Token: Equatable, Sendable { case plain, keyword, string, comment, number }

    static let keywords: Set = [
        "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default", "defer", "do", "elif",
        "else", "enum", "except", "export", "extends", "extension", "false", "final", "finally", "fn", "for", "from", "func",
        "function", "go", "guard", "if", "impl", "import", "in", "interface", "is", "let", "match", "mod", "mut", "new", "nil",
        "None", "null", "of", "package", "pass", "private", "protocol", "pub", "public", "raise", "return", "self", "static",
        "struct", "super", "switch", "this", "throw", "throws", "trait", "True", "true", "False", "try", "type", "undefined",
        "use", "var", "void", "where", "while", "with", "yield",
    ]

    /// How a line comment starts for a file, from its extension.
    static func commentMarker(_ fileExtension: String) -> String {
        switch fileExtension.lowercased() {
        case "py", "sh", "bash", "zsh", "rb", "yml", "yaml", "toml", "pl", "r", "ps1", "conf", "dockerfile": "#"
        case "sql", "lua", "hs": "--"
        default: "//"
        }
    }

    /// The line cut into runs of one token each.
    public static func tokens(_ line: String, fileExtension: String) -> [(text: String, token: Token)] {
        let marker = commentMarker(fileExtension)
        var result: [(String, Token)] = []
        var index = line.startIndex
        func add(_ text: Substring, _ token: Token) {
            if let last = result.last, last.1 == token { result[result.count - 1].0 += text } else { result.append((String(text), token)) }
        }
        while index < line.endIndex {
            let rest = line[index...]
            let character = line[index]
            if rest.hasPrefix(marker) {
                add(rest, .comment)
                break
            } else if character == "\"" || character == "'" || character == "`" {
                var end = line.index(after: index)
                while end < line.endIndex, line[end] != character {
                    end =
                        line[end] == "\\" && line.index(after: end) < line.endIndex ? line.index(end, offsetBy: 2) : line.index(after: end)
                }
                end = end < line.endIndex ? line.index(after: end) : end
                add(line[index..<end], .string)
                index = end
            } else if character.isLetter || character == "_" {
                let end = rest.firstIndex { !($0.isLetter || $0.isNumber || $0 == "_") } ?? line.endIndex
                let word = line[index..<end]
                add(word, keywords.contains(String(word)) ? .keyword : .plain)
                index = end
            } else if character.isNumber {
                let end = rest.firstIndex { !($0.isNumber || $0 == "." || $0 == "_" || $0.isLetter) } ?? line.endIndex
                add(line[index..<end], .number)
                index = end
            } else {
                add(line[index...index], .plain)
                index = line.index(after: index)
            }
        }
        return result
    }
}
