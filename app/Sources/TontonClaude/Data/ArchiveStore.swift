import AppKit
import CryptoKit
import Foundation
import OSLog
import TontonCore

/// The archive of Settings › Archive: finished conversations kept on this Mac, sealed with a key of its own, one archive
/// per account. Opening one renders it as a page for the browser, removed soon after.
@MainActor
final class ArchiveStore: ObservableObject {
    @Published private(set) var summaries: [ConversationArchive.Summary] = []
    /// Matches of the notch's search, for `searchQuery`.
    @Published private(set) var matches: [ConversationSearch.Match] = []
    @Published private(set) var searchQuery = ""
    /// Why the archive can't be used, or why the last action failed.
    @Published var failure: String?
    private var key: SymmetricKey?
    private var account: Account?
    private var archive: ConversationArchive?
    /// The archived text, made once per search session off the main thread, dropped when the search ends.
    private var index: ArchiveSearchIndex?
    private var searchTask: Task<Void, Never>?
    /// What the notch is searching for, to search again when the archive changes.
    private var query = ""
    /// Bumped whenever the archive or the search changes: an answer made before is dropped.
    private var generation = 0
    private var pageTimers: [String: Task<Void, Never>] = [:]

    private static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Tonton Claude")
    }
    private static var keyFile: URL { folder.appendingPathComponent("archive.key") }
    private static var root: URL { folder.appendingPathComponent("Archive") }

    /// Pages opened from the archive, plain text: they go a minute after opening, when the app quits, and at launch.
    private static var pages: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("Tonton Claude Archive", isDirectory: true)
    }

    init() {
        removePages()
        loadKey()
    }

    private func loadKey() {
        do {
            key = try ConversationArchive.key(at: Self.keyFile)
        } catch {
            Logger.app.error("archive: the key can't be read")
            key = nil
            failure = String(
                localized: "The archive's key can't be read, so nothing can be archived or opened. Delete all starts a new archive.")
        }
    }

    /// Each account has its archive; without one, this Mac's sessions have theirs.
    func use(account: Account?) {
        self.account = account
        archive = key.map { ConversationArchive(directory: Self.folder(for: account), key: $0) }
        archive?.sweep()
        endSearch()
        reload()
    }

    private static func folder(for account: Account?) -> URL {
        let scope = account.map(AccountList.id(of:)) ?? "this-mac"
        let name = SHA256.hash(data: Data(scope.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(name)
    }

    /// Keeps a session's conversation. A copy that ends earlier than the one already archived is not kept: the app may
    /// only have part of it.
    func add(_ session: SessionSummary, entries: [Entry]) {
        let messages = entries.filter { $0.kind == .user || $0.kind == .assistant }.count
        guard let archive, messages > 0 else { return }
        let lastEntry = entries.map(\.ts).max()
        if let kept = summaries.first(where: { $0.id == session.id }), let keptLast = kept.lastEntry, let lastEntry, keptLast > lastEntry {
            return
        }
        let summary = ConversationArchive.Summary(
            id: session.id, project: session.project, machine: session.machine, title: session.title, archivedAt: Date(),
            messages: messages, lastEntry: lastEntry)
        do {
            try archive.save(ConversationArchive.Conversation(summary: summary, entries: entries))
            reload()
        } catch {
            failure = String(localized: "Could not archive \(session.project): \(Self.describe(error))")
        }
    }

    func delete(_ id: String) {
        do {
            try archive?.delete(id)
            removePage(of: id)
            reload()
        } catch {
            failure = String(localized: "Could not delete it: \(Self.describe(error))")
        }
    }

    /// Deletes this account's archive, also when its list can't be read. Without a readable key nothing archived can be
    /// read again: then every account's archive starts over, with a new key.
    func deleteAll() {
        if key == nil {
            try? FileManager.default.removeItem(at: Self.root)
            try? FileManager.default.removeItem(at: Self.keyFile)
            failure = nil
            loadKey()
        } else {
            archive?.deleteAll()
        }
        removePages()
        use(account: account)
    }

    /// An account deleted from the relay: its archive goes too.
    func forget(_ account: Account) {
        try? FileManager.default.removeItem(at: Self.folder(for: account))
    }

    /// Searches the archive in the background; `matches` follows. A short query ends the search and frees its text.
    func search(_ query: String) {
        searchTask?.cancel()
        guard let archive, query.count >= ConversationSearch.minimumQueryLength else { return endSearch() }
        self.query = query
        generation += 1
        let current = generation
        let ids = summaries.map(\.id)
        let ready = index
        searchTask = Task { [weak self] in
            // Typing goes on: wait for a pause.
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let work = Task.detached(priority: .userInitiated) {
                let index = ready ?? ArchiveSearchIndex(archive, ids: ids)
                return (index, index.search(query))
            }
            let (built, found) = await withTaskCancellationHandler {
                await work.value
            } onCancel: {
                work.cancel()
            }
            guard let self, !Task.isCancelled, generation == current else { return }
            index = built
            matches = found
            searchQuery = query
        }
    }

    func endSearch() {
        searchTask?.cancel()
        query = ""
        generation += 1
        index = nil
        matches = []
        searchQuery = ""
    }

    /// The conversation as a page in the browser, written where only the user can read it and removed a minute later.
    /// Returns why it couldn't, if it couldn't.
    @discardableResult
    func open(_ id: String) -> String? {
        guard let conversation = archive?.load(id) else { return String(localized: "This conversation can't be read any more.") }
        let summary = conversation.summary
        let archived = summary.archivedAt.formatted(date: .abbreviated, time: .shortened)
        let page = ConversationExport.render(
            .html, title: summary.title ?? summary.project, subtitle: String(localized: "\(summary.machine) · archived \(archived)"),
            entries: conversation.entries)
        try? FileManager.default.createDirectory(at: Self.pages, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = Self.page(of: id)
        guard FileManager.default.createFile(atPath: url.path, contents: Data(page.utf8), attributes: [.posixPermissions: 0o600]) else {
            return String(localized: "Could not open \(summary.project).")
        }
        NSWorkspace.shared.open(url)
        // Opened again: the minute starts over.
        pageTimers[id]?.cancel()
        pageTimers[id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled else { return }
            self?.removePage(of: id)
        }
        return nil
    }

    /// When the app quits, and at launch for a quit that didn't get to it.
    func removePages() {
        try? FileManager.default.removeItem(at: Self.pages)
    }

    /// The session id, not the project's name: it holds nothing that could be a path.
    private static func page(of id: String) -> URL {
        pages.appendingPathComponent("conversation-\(id.filter { $0.isLetter || $0.isNumber }.prefix(16)).html")
    }

    private func removePage(of id: String) {
        pageTimers[id] = nil
        try? FileManager.default.removeItem(at: Self.page(of: id))
    }

    private func reload() {
        // What the search found may be gone, or miss the new ones: it starts over.
        let searching = query
        endSearch()
        defer { if !searching.isEmpty { search(searching) } }
        guard let archive else { return summaries = [] }
        do {
            summaries = try archive.list()
            if key != nil { failure = nil }
        } catch {
            summaries = []
            failure = String(localized: "The archive's list can't be read. Nothing is written over it; Delete all starts over.")
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error as? ConversationArchive.Failure {
        case .unreadableIndex: String(localized: "the archive's list can't be read.")
        case .unreadableKey: String(localized: "the archive's key can't be read.")
        case nil: error.localizedDescription
        }
    }
}
