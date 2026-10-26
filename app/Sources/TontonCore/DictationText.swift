import Foundation

/// How dictated words join what was already typed in the composer.
public enum DictationText {
    /// `typed` stays as it was; the transcript follows it, after a space when both have words.
    public static func merge(typed: String, transcript: String) -> String {
        let words = transcript.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else { return typed }
        guard let last = typed.last else { return words }
        return last.isWhitespace ? typed + words : typed + " " + words
    }
}
