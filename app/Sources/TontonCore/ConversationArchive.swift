import CryptoKit
import Foundation

/// Finished conversations kept on this Mac to read later. Each one is sealed like everything else the app keeps from the
/// relay (AES-256-GCM, see E2E), with a key of this Mac's own, and written to a folder only the user can read. An index,
/// sealed too, lists them without opening each one.
public struct ConversationArchive: Sendable {
    public struct Summary: Codable, Equatable, Identifiable, Sendable {
        /// The session's id.
        public let id: String
        public let project: String
        public let machine: String
        public let title: String?
        public let archivedAt: Date
        public let messages: Int
        /// When the last entry was written: a copy that ends earlier is older, whatever its length.
        public let lastEntry: String?

        public init(
            id: String, project: String, machine: String, title: String?, archivedAt: Date, messages: Int, lastEntry: String? = nil
        ) {
            self.id = id
            self.project = project
            self.machine = machine
            self.title = title
            self.archivedAt = archivedAt
            self.messages = messages
            self.lastEntry = lastEntry
        }
    }

    public struct Conversation: Codable, Equatable, Sendable {
        public let summary: Summary
        public let entries: [Entry]

        public init(summary: Summary, entries: [Entry]) {
            self.summary = summary
            self.entries = entries
        }
    }

    public enum Failure: Error, Equatable {
        /// The index is there but can't be opened: nothing is written over it, it may still hold everything.
        case unreadableIndex
        case unreadableKey
    }

    /// The most recent ones are kept: older ones go as new ones come.
    public static let kept = 200

    public let directory: URL
    private let key: SymmetricKey

    public init(directory: URL, key: SymmetricKey) {
        self.directory = directory
        self.key = key
    }

    /// The archive's key, from its file, made the first time only. A file that can't be read is an error, never a reason
    /// to make another key: that would leave everything archived unreadable.
    public static func key(at url: URL) throws -> SymmetricKey {
        guard FileManager.default.fileExists(atPath: url.path) else {
            let fresh = E2E.newKey()
            try write(Data(fresh.utf8), to: url)
            return try E2E.key(fromBase64URL: fresh)
        }
        guard let saved = try? String(contentsOf: url, encoding: .utf8),
            let key = try? E2E.key(fromBase64URL: saved.trimmingCharacters(in: .whitespacesAndNewlines))
        else { throw Failure.unreadableKey }
        return key
    }

    /// The archived conversations, the latest first. Empty before anything was archived; an error when the index can't be
    /// opened. An index gone missing is made again from the conversations, which each hold their summary.
    public func list() throws -> [Summary] {
        guard FileManager.default.fileExists(atPath: indexFile.path) else { return try rebuildIndex() }
        guard let blob = try? String(contentsOf: indexFile, encoding: .utf8), let list = try? E2E.open(blob, as: [Summary].self, with: key)
        else { throw Failure.unreadableIndex }
        return list
    }

    /// Archives a conversation, or replaces the one of the same session: it may have gone on since. The file comes first
    /// and the index after, so the index never lists a file that isn't there.
    public func save(_ conversation: Conversation) throws {
        let others = try list().filter { $0.id != conversation.summary.id }
        try Self.write(Data(try E2E.seal(conversation, with: key).utf8), to: file(for: conversation.summary.id))
        let summaries = ([conversation.summary] + others).sorted { $0.archivedAt > $1.archivedAt }
        try saveIndex(Array(summaries.prefix(Self.kept)))
        for old in summaries.dropFirst(Self.kept) { try? FileManager.default.removeItem(at: file(for: old.id)) }
    }

    public func load(_ id: String) -> Conversation? {
        guard let blob = try? String(contentsOf: file(for: id), encoding: .utf8) else { return nil }
        return try? E2E.open(blob, as: Conversation.self, with: key)
    }

    /// Out of the index first, then off the disk.
    public func delete(_ id: String) throws {
        try saveIndex(try list().filter { $0.id != id })
        try? FileManager.default.removeItem(at: file(for: id))
    }

    public func deleteAll() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Removes the files the index doesn't list: left by a crash between two writes. Nothing when the index can't be read.
    public func sweep() {
        guard let listed = try? Set(list().map { file(for: $0.id).lastPathComponent }) else { return }
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        for url in files where url.lastPathComponent != indexFile.lastPathComponent && !listed.contains(url.lastPathComponent) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    private var indexFile: URL { directory.appendingPathComponent("index.sealed") }

    private func rebuildIndex() throws -> [Summary] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let summaries = files.filter { $0.pathExtension == "sealed" }.compactMap { url -> Summary? in
            guard let blob = try? String(contentsOf: url, encoding: .utf8) else { return nil }
            return (try? E2E.open(blob, as: Conversation.self, with: key))?.summary
        }
        guard !summaries.isEmpty else { return [] }
        let sorted = summaries.sorted { $0.archivedAt > $1.archivedAt }
        try saveIndex(sorted)
        return sorted
    }

    /// Session ids come from the relay: a hash makes a safe file name of any of them.
    private func file(for id: String) -> URL {
        let digest = SHA256.hash(data: Data(id.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(digest).sealed")
    }

    private func saveIndex(_ summaries: [Summary]) throws {
        try Self.write(Data(try E2E.seal(summaries, with: key).utf8), to: indexFile)
    }

    /// Readable by the user only from the start, then moved in place in one step.
    private static func write(_ data: Data, to url: URL) throws {
        let folder = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let partial = url.appendingPathExtension("partial")
        guard FileManager.default.createFile(atPath: partial.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
        }
        guard rename(partial.path, url.path) == 0 else {
            try? FileManager.default.removeItem(at: partial)
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
        }
    }
}

/// What the notch's search reads of the archive: the messages and the tool calls, without images or tool output, folded
/// once for case and accents so a search only compares plain strings. Made off the main thread.
public struct ArchiveSearchIndex: Sendable {
    struct Item: Sendable {
        let itemId: String
        let kind: EntryKind
        let text: String
        /// Folded, as UTF-8 bytes: a plain byte search is many times faster than comparing Strings.
        let folded: [UInt8]
    }

    private let conversations: [(id: String, items: [Item])]

    /// Stops early when its task is cancelled: a search that changed doesn't need the rest.
    public init(_ archive: ConversationArchive, ids: [String]) {
        var conversations: [(id: String, items: [Item])] = []
        for id in ids {
            if Task.isCancelled { break }
            guard let conversation = archive.load(id) else { continue }
            let items = conversation.entries.compactMap { entry -> Item? in
                let text: String? =
                    switch entry.kind {
                    case .user, .assistant: entry.text
                    case .tool: "\(entry.name ?? "") \(entry.summary ?? "")"
                    default: nil
                    }
                guard let text, !text.isEmpty else { return nil }
                return Item(itemId: entry.id, kind: entry.kind, text: text, folded: Array(Self.fold(text).utf8))
            }
            conversations.append((id, items))
        }
        self.conversations = conversations
    }

    static func fold(_ text: String) -> String { text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }

    /// Like the search of open conversations: the latest conversation first, the latest message first in each.
    public func search(_ query: String, limit: Int = 20) -> [ConversationSearch.Match] {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard words.count >= ConversationSearch.minimumQueryLength else { return [] }
        let needle = Array(Self.fold(words).utf8)
        var matches: [ConversationSearch.Match] = []
        for (id, items) in conversations {
            if Task.isCancelled { return matches }
            for item in items.reversed() where Self.contains(item.folded, needle) {
                // The snippet comes from the text as written, around the same words.
                let start = item.text.startIndex
                let range = item.text.range(of: words, options: [.caseInsensitive, .diacriticInsensitive]) ?? start..<start
                matches.append(
                    ConversationSearch.Match(
                        sessionId: id, itemId: item.itemId, kind: item.kind, snippet: ConversationSearch.snippet(item.text, around: range)))
                if matches.count >= limit { return matches }
            }
        }
        return matches
    }

    static func contains(_ haystack: [UInt8], _ needle: [UInt8]) -> Bool {
        haystack.withUnsafeBytes { hay in
            needle.withUnsafeBytes { word in memmem(hay.baseAddress, hay.count, word.baseAddress, word.count) != nil }
        }
    }
}
