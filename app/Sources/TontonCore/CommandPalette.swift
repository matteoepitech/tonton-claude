import Foundation

/// Fuzzy matching for the command palette: the query's characters in order, anywhere in the text, best when they start
/// words and follow each other.
public enum FuzzyMatch {
    /// Higher is better; nil when the query doesn't match. An empty query matches everything with 0.
    public static func score(_ query: String, in text: String) -> Int? {
        let query = Array(query.lowercased().filter { !$0.isWhitespace })
        guard !query.isEmpty else { return 0 }
        let characters = Array(text)
        let lowered = Array(text.lowercased())
        var score = 0
        var next = 0
        var previous: Int?
        for (index, character) in lowered.enumerated() where next < query.count && character == query[next] {
            let startsWord =
                index == 0 || !characters[index - 1].isLetter || (characters[index].isUppercase && characters[index - 1].isLowercase)
            score += 1 + (startsWord ? 8 : 0) + (previous == index - 1 ? 5 : 0)
            previous = index
            next += 1
        }
        guard next == query.count else { return nil }
        // Shorter texts win a tie: the query covers more of them.
        return score * 100 - characters.count
    }

    /// The items that match, best first, keeping the original order for equal scores.
    public static func rank<T>(_ items: [T], query: String, text: (T) -> String) -> [T] {
        items.enumerated()
            .compactMap { index, item in score(query, in: text(item)).map { (item, $0, index) } }
            .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.2 < $1.2 }
            .map(\.0)
    }
}
