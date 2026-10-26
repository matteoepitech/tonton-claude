import Foundation
import TontonCore

/// Watches the `claude` sessions of this Mac in Claude Code's own files (see `LocalSessions`), off the main thread, and
/// hands every change to `onChange`. Sessions whose process is gone stay as ended until the app quits.
final class LocalSessionWatcher {
    private static let pollInterval: DispatchTimeInterval = .seconds(1)
    /// Ended sessions kept in the list, the most recent first.
    private static let maxEnded = 30

    private struct Tracked {
        var record: LocalSessions.Record
        var tail: TranscriptTail?
        var conversation = LocalSessions.Conversation()
        var endedAt: Date?
    }

    /// Called on the main thread with every session and its entries, whenever something changed.
    var onChange: (@MainActor ([SessionSummary], [String: [Entry]]) -> Void)?

    private let queue = DispatchQueue(label: "tech.d3l.tontonclaude.local-sessions", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var tracked: [String: Tracked] = [:]

    func start() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: Self.pollInterval)
        timer.setEventHandler { [weak self] in self?.poll() }
        timer.resume()
        self.timer = timer
    }

    private func poll() {
        var changed = false
        let running = LocalSessions.running()
        let runningIds = Set(running.map(\.sessionId))

        for record in running {
            var session = tracked[record.sessionId] ?? Tracked(record: record)
            if session.record != record || session.endedAt != nil { changed = true }
            session.record = record
            session.endedAt = nil
            // The transcript appears with the first message.
            if session.tail == nil, let url = LocalSessions.transcript(of: record.sessionId) { session.tail = TranscriptTail(url: url) }
            if let read = session.tail?.read(), read.reset || !read.lines.isEmpty {
                session.conversation.apply(read)
                changed = true
            }
            tracked[record.sessionId] = session
        }
        for (id, session) in tracked where session.endedAt == nil && !runningIds.contains(id) {
            tracked[id]?.endedAt = Date()
            changed = true
        }
        let ended = tracked.values.filter { $0.endedAt != nil }.sorted { ($0.endedAt ?? .distantPast) > ($1.endedAt ?? .distantPast) }
        for session in ended.dropFirst(Self.maxEnded) { tracked[session.record.sessionId] = nil }

        guard changed, let onChange else { return }
        let sessions = tracked.values.map { LocalSessions.summary($0.record, $0.conversation, endedAt: $0.endedAt) }
        let entries = tracked.mapValues(\.conversation.entries)
        DispatchQueue.main.async { MainActor.assumeIsolated { onChange(sessions, entries) } }
    }
}
