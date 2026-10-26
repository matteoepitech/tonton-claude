import Foundation

/// Full-text search over the conversations the app holds, in memory: decrypted messages never go to disk.
public enum ConversationSearch {
    public struct Hit: Identifiable, Equatable, Sendable {
        public let sessionId: String
        /// The chat item to scroll to: a tool result points to its call.
        public let itemId: String
        public let kind: EntryKind
        public let snippet: String
        public let ts: String
        public var id: String { "\(sessionId)/\(itemId)" }
    }

    /// Entries that contain every word of the query, ignoring case and accents, newest first.
    public static func search(_ query: String, in conversations: [String: [Entry]], limit: Int = 50) -> [Hit] {
        let words = query.split(whereSeparator: \.isWhitespace).map { fold(String($0)) }
        guard !words.isEmpty else { return [] }
        var hits: [Hit] = []
        for (sessionId, entries) in conversations {
            let calls = Dictionary(entries.filter { $0.kind == .tool }.compactMap { e in e.toolUseId.map { ($0, e.id) } }) { first, _ in
                first
            }
            for entry in entries {
                guard let text = searchable(entry), case let folded = fold(text), words.allSatisfy(folded.contains) else { continue }
                let itemId = entry.kind == .toolResult ? entry.toolUseId.flatMap { calls[$0] } ?? entry.id : entry.id
                hits.append(
                    Hit(sessionId: sessionId, itemId: itemId, kind: entry.kind, snippet: snippet(text, around: words[0]), ts: entry.ts))
            }
        }
        return Array(hits.sorted { $0.ts > $1.ts }.prefix(limit))
    }

    private static func searchable(_ entry: Entry) -> String? {
        switch entry.kind {
        case .tool: [entry.name, entry.summary].compactMap { $0 }.joined(separator: " ")
        default: entry.text
        }
    }

    static func fold(_ text: String) -> String { text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }

    /// One line around the first occurrence of `word`, cut with ellipses.
    static func snippet(_ text: String, around word: String) -> String {
        let line = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        guard let match = fold(line).range(of: word) else { return String(line.prefix(120)) }
        let offset = fold(line).distance(from: fold(line).startIndex, to: match.lowerBound)
        let start = max(0, offset - 40)
        let characters = Array(line)
        let end = min(characters.count, start + 140)
        return (start > 0 ? "…" : "") + String(characters[start..<end]) + (end < characters.count ? "…" : "")
    }
}
