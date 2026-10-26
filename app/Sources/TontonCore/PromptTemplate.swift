import Foundation

/// A saved prompt whose `{name}` placeholders are filled in before it goes into the message field, e.g.
/// `Review PR #{number}`. A placeholder starts right after `{` with a letter or digit and holds letters, digits, spaces,
/// `_` and `-`, so JSON or code in a prompt (`{"a": 1}`, `{ return b }`) stays as is.
public struct PromptTemplate: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var name: String
    public var text: String

    public init(id: UUID = UUID(), name: String, text: String) {
        self.id = id
        self.name = name
        self.text = text
    }

    /// Each placeholder once, in the order it first appears.
    public var variables: [String] {
        var seen: [String] = []
        for match in text.matches(of: Self.placeholder) {
            let name = Self.name(of: match.1)
            if !seen.contains(name) { seen.append(name) }
        }
        return seen
    }

    /// The text with every placeholder replaced; one without a value keeps its braces.
    public func filled(_ values: [String: String]) -> String {
        text.replacing(Self.placeholder) { match in
            values[Self.name(of: match.1)] ?? String(match.0)
        }
    }

    private static let placeholder = #/\{([\p{L}\p{N}_][\p{L}\p{N}_ -]*)\}/#
    private static func name(of raw: Substring) -> String { raw.trimmingCharacters(in: .whitespaces) }
}
