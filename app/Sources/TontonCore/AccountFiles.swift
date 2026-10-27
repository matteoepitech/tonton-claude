import CryptoKit
import Foundation

/// The accounts of `AccountList` on disk: one file each in a directory only the user can read, so their keys stay
/// apart. Files are written whole or not at all, and a file this version can't read is left alone: it may hold the only
/// copy of a key, written by a newer version.
public struct AccountFiles: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// A file name that says nothing about the account.
    func file(for id: String) -> URL {
        let digest = SHA256.hash(data: Data(id.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(digest).json")
    }

    private func prepare() {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    private var files: [URL] {
        let all = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.creationDateKey])) ?? []
        let created = { (url: URL) in (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast }
        return all.filter { $0.pathExtension == "json" }.sorted { created($0) < created($1) }
    }

    /// In the order they were added.
    public func load() -> AccountList {
        prepare()
        return AccountList(files.compactMap { try? JSONDecoder().decode(AccountList.Entry.self, from: Data(contentsOf: $0)) })
    }

    /// Writes the accounts that changed and removes the files of the ones signed out.
    public func save(_ list: AccountList) {
        prepare()
        let encoder = JSONEncoder()
        // The same bytes for the same account, from one launch to the next: unchanged files are not rewritten.
        encoder.outputFormatting = .sortedKeys
        let kept = Set(list.entries.map(\.id))
        for entry in list.entries {
            let url = file(for: entry.id)
            guard let data = try? encoder.encode(entry), (try? Data(contentsOf: url)) != data else { continue }
            write(data, to: url)
        }
        for url in files {
            guard let entry = try? JSONDecoder().decode(AccountList.Entry.self, from: Data(contentsOf: url)), !kept.contains(entry.id)
            else { continue }
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// Readable by the user only from the start, then moved in place in one step.
    private func write(_ data: Data, to url: URL) {
        let partial = url.appendingPathExtension("partial")
        guard FileManager.default.createFile(atPath: partial.path, contents: data, attributes: [.posixPermissions: 0o600]) else { return }
        if rename(partial.path, url.path) != 0 { try? FileManager.default.removeItem(at: partial) }
    }
}
