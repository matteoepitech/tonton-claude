import Foundation
import TontonCore
import TontonMac

/// Watches the Codex sessions of this Mac in Codex's own rollouts (see `CodexLocal`), off the main thread, and hands every
/// change to `onChange`. A session is live while Codex has its rollout open; once closed it stays as ended while it is
/// recent. Nothing is written anywhere.
final class CodexLocalWatcher {
    private static let pollInterval: DispatchTimeInterval = .milliseconds(1500)
    /// Rollouts followed at most, the live and most recent first: each is read from its end at first.
    private static let maxSessions = 20

    private struct Tracked {
        let session: CodexRollout.Session
        let tail: TranscriptTail
        var conversation = CodexConversation()
        var modified: Date
    }

    /// Called on the main thread with every session and its entries, whenever something changed.
    var onChange: (@MainActor ([SessionSummary], [String: [Entry]]) -> Void)?

    private let queue = DispatchQueue(label: "tech.d3l.tontonclaude.codex-sessions", qos: .utility)
    private var timer: DispatchSourceTimer?
    /// By the rollout's real path.
    private var tracked: [String: Tracked] = [:]
    /// Rollouts that are no session to show: subagents' threads, a first line that is not a session_meta.
    private var skipped: Set<String> = []
    /// The names of each Codex home's threads, read again when its index changes.
    private var names: [String: (modified: Date?, names: [String: String])] = [:]
    private var published: [SessionSummary] = []
    private var publishedEntries: [String: [Entry]] = [:]

    func start() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: Self.pollInterval)
        timer.setEventHandler { [weak self] in self?.poll() }
        timer.resume()
        self.timer = timer
    }

    private func poll() {
        let now = Date()
        let since = now.addingTimeInterval(-CodexLocal.recent)
        let open = CodexLocal.openRollouts()
        let found = CodexLocal.rollouts(in: CodexLocal.home().appendingPathComponent("sessions"), since: since, now: now)
            .map { CodexLocal.realPath($0.path) }
        // A resumed session's rollout stays in the folder of the day it started: Codex having it open finds it.
        let seen = Set(found).union(open ?? []).union(tracked.keys)
        let candidates = seen.subtracting(skipped).compactMap { path -> (path: String, modified: Date, live: Bool)? in
            guard let modified = CodexLocal.modified(URL(fileURLWithPath: path)) else { return nil }
            let live = open?.contains(path) ?? false
            return live || modified >= since ? (path, modified, live) : nil
        }
        .sorted { $0.live != $1.live ? $0.live : $0.modified > $1.modified }
        .prefix(Self.maxSessions)

        var kept: [String: Tracked] = [:]
        for candidate in candidates {
            guard var session = tracked[candidate.path] ?? track(candidate.path, candidate.modified) else { continue }
            session.modified = candidate.modified
            let read = session.tail.read()
            if read.reset || !read.lines.isEmpty { session.conversation.apply(read) }
            kept[candidate.path] = session
        }
        tracked = kept
        skipped.formIntersection(seen)
        publish(open)
    }

    /// A rollout seen for the first time: its session, or nothing yet.
    private func track(_ path: String, _ modified: Date) -> Tracked? {
        let url = URL(fileURLWithPath: path)
        switch CodexLocal.firstLine(of: url) {
        case .session(let session) where !session.subagent:
            return Tracked(session: session, tail: TranscriptTail(url: url), modified: modified)
        case .notYet:
            return nil
        case .session, .other:
            skipped.insert(path)
            return nil
        }
    }

    private func publish(_ open: Set<String>?) {
        // The same session twice, as a thread Codex wrote again elsewhere: the newest rollout wins.
        var newest: [String: (path: String, tracked: Tracked)] = [:]
        for (path, session) in tracked where newest[session.session.sessionId].map({ $0.tracked.modified < session.modified }) ?? true {
            newest[session.session.sessionId] = (path, session)
        }
        var sessions: [SessionSummary] = []
        var entries: [String: [Entry]] = [:]
        for (path, session) in newest.values {
            let name = CodexLocal.home(ofRollout: URL(fileURLWithPath: path)).flatMap { threadName(session.session.threadId, in: $0) }
            sessions.append(
                CodexLocal.summary(
                    session.session, session.conversation, name: name, live: open.map { $0.contains(path) }, modified: session.modified))
            entries[session.session.sessionId] = session.conversation.entries
        }
        sessions.sort { $0.lastActivity > $1.lastActivity }
        guard sessions != published || entries != publishedEntries, let onChange else { return }
        published = sessions
        publishedEntries = entries
        DispatchQueue.main.async { MainActor.assumeIsolated { onChange(sessions, entries) } }
    }

    private func threadName(_ threadId: String, in home: URL) -> String? {
        let modified = CodexLocal.modified(home.appendingPathComponent("session_index.jsonl"))
        if let known = names[home.path], known.modified == modified { return known.names[threadId] }
        let read = CodexLocal.threadNames(in: home)
        names[home.path] = (modified, read)
        return read[threadId]
    }
}
