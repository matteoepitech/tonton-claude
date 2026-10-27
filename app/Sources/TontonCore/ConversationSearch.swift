import Foundation

/// Full-text search over the conversations the app has decrypted, in memory only: what Claude and the user said, tool
/// calls and their results. Case and accents do not matter.
public enum ConversationSearch {
    public struct Match: Equatable, Identifiable, Sendable {
        public let sessionId: String
        /// The chat item to scroll to: for a tool result, its tool call, which is where the chat shows it.
        public let itemId: String
        public let kind: EntryKind
        /// The text around the first match, on one line.
        public let snippet: String
        public var id: String { "\(sessionId)/\(itemId)" }
    }

    public static let minimumQueryLength = 3
    static let snippetRadius = 40

    /// The most recent matches first, `limit` at most, from sessions in the given order.
    public static func search(_ query: String, sessions: [SessionSummary], entries: [String: [Entry]], limit: Int = 50) -> [Match] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard needle.count >= minimumQueryLength else { return [] }
        var matches: [Match] = []
        for session in sessions {
            let list = entries[session.id] ?? []
            let callIds = Dictionary(list.filter { $0.kind == .tool }.compactMap { e in e.toolUseId.map { ($0, e.id) } }) { first, _ in
                first
            }
            var seen: Set<String> = []
            // Subagent calls are folded under their task, with no item of their own to show.
            for entry in list.reversed() where !entry.kind.isSubagent {
                let haystack = entry.kind == .tool ? "\(entry.name ?? "") \(entry.summary ?? "")" : entry.text ?? ""
                guard let range = haystack.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) else { continue }
                let itemId = entry.kind == .toolResult ? entry.toolUseId.flatMap { callIds[$0] } ?? entry.id : entry.id
                // A tool call and its result are one item in the chat: one match is enough.
                guard seen.insert(itemId).inserted else { continue }
                matches.append(Match(sessionId: session.id, itemId: itemId, kind: entry.kind, snippet: snippet(haystack, around: range)))
                if matches.count >= limit { return matches }
            }
        }
        return matches
    }

    static func snippet(_ text: String, around range: Range<String.Index>) -> String {
        let start = text.index(range.lowerBound, offsetBy: -snippetRadius, limitedBy: text.startIndex) ?? text.startIndex
        let end = text.index(range.upperBound, offsetBy: snippetRadius, limitedBy: text.endIndex) ?? text.endIndex
        let piece = text[start..<end].replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return (start > text.startIndex ? "…" : "") + piece + (end < text.endIndex ? "…" : "")
    }
}
