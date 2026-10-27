import Foundation

/// A few lines the user keeps with a session, such as what to check once Claude is done. They stay on this Mac: nothing
/// here is sent to the relay or to the session.
public struct SessionNotes: Codable, Equatable, Sendable {
    public static let maxLength = 2000
    /// Notes of the sessions edited longest ago go first.
    public static let maxSessions = 200

    public struct Note: Codable, Equatable, Sendable {
        public let text: String
        public let updatedAt: Date
    }

    public private(set) var notes: [String: Note] = [:]

    public init() {}

    public func text(for sessionId: String) -> String { notes[sessionId]?.text ?? "" }

    public func has(_ sessionId: String) -> Bool { notes[sessionId] != nil }

    /// Sets the session's note. Blank text removes it; longer text is cut to `maxLength`.
    public mutating func set(_ text: String, for sessionId: String, at now: Date = Date()) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            notes[sessionId] = nil
            return
        }
        notes[sessionId] = Note(text: String(text.prefix(Self.maxLength)), updatedAt: now)
        let extra = notes.count - Self.maxSessions
        guard extra > 0 else { return }
        for oldest in notes.sorted(by: { $0.value.updatedAt < $1.value.updatedAt }).prefix(extra).map(\.key) {
            notes[oldest] = nil
        }
    }

    /// For the session list's search: a word from the note finds its session.
    public func matches(_ sessionId: String, _ query: String) -> Bool {
        !query.isEmpty && (notes[sessionId]?.text.localizedCaseInsensitiveContains(query) ?? false)
    }

    // MARK: File

    /// `notes.json` next to the account, readable by the user only. A file that cannot be read gives no notes.
    public static func load(from url: URL) -> SessionNotes {
        guard let data = try? Data(contentsOf: url), var notes = try? JSONDecoder().decode(SessionNotes.self, from: data) else {
            return SessionNotes()
        }
        // A file edited by hand is held to the same limits.
        for (sessionId, note) in notes.notes { notes.set(note.text, for: sessionId, at: note.updatedAt) }
        return notes
    }

    public func save(to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
