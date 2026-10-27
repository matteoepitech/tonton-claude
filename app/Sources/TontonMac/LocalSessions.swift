import Foundation
import TontonCore

/// The `claude` sessions running on this Mac, read straight from Claude Code's files: they show up in the notch without
/// an agent, an account or a relay. Read only, since replies and approvals go through the agent's channel.
public enum LocalSessions {
    /// The machine id of sessions read this way.
    public static let machineId = "this-mac"
    /// Like the agent's backlog: older entries are dropped.
    static let maxEntries = 400

    /// Claude Code's directory: `sessions/` has one file per running process, `projects/` the transcripts.
    public static var claudeHome: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude", isDirectory: true)
    }

    /// The registry entries of the running sessions. Only `<pid>.json` files are read: the `.key` files next to them hold
    /// the tokens Claude Code sessions use to message each other.
    public static func running(in home: URL = claudeHome, isAlive: (Int32) -> Bool = processIsAlive) -> [Record] {
        let directory = home.appendingPathComponent("sessions", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap { file in
            (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Record.self, from: $0) }
        }
        .filter { isAlive($0.pid) }
    }

    /// The transcript of a session, wherever Claude Code put its project directory.
    public static func transcript(of sessionId: String, in home: URL = claudeHome) -> URL? {
        let projects = home.appendingPathComponent("projects", isDirectory: true)
        let directories = (try? FileManager.default.contentsOfDirectory(at: projects, includingPropertiesForKeys: nil)) ?? []
        return directories.lazy.map { $0.appendingPathComponent("\(sessionId).jsonl") }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// A file left behind by a process that crashed is not a running session.
    public static func processIsAlive(_ pid: Int32) -> Bool {
        pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
    }

    /// One `~/.claude/sessions/<pid>.json`. The format is not public: only these fields are read, and any can be missing.
    public struct Record: Decodable, Equatable, Sendable {
        public let pid: Int32
        public let sessionId: String
        public let cwd: String
        /// `busy`, `waiting` or `idle`.
        public let status: String?
        /// Why it waits, e.g. "input needed".
        public let waitingFor: String?
        /// Milliseconds since 1970.
        public let startedAt: Double?
        public let updatedAt: Double?

        public init(
            pid: Int32, sessionId: String, cwd: String, status: String?, waitingFor: String? = nil, startedAt: Double? = nil,
            updatedAt: Double? = nil
        ) {
            self.pid = pid
            self.sessionId = sessionId
            self.cwd = cwd
            self.status = status
            self.waitingFor = waitingFor
            self.startedAt = startedAt
            self.updatedAt = updatedAt
        }

        /// `waiting` is also what a session reports while its prompt waits for the next message, so only a wait that
        /// mentions a permission asks for the user's attention.
        public var sessionStatus: SessionStatus {
            switch status {
            case "busy": .working
            case "waiting" where waitingFor?.range(of: "permission|approv", options: [.regularExpression, .caseInsensitive]) != nil:
                .permission
            default: .idle
            }
        }
    }

    /// What one session's transcript has said so far.
    public struct Conversation: Equatable, Sendable {
        public private(set) var entries: [Entry] = []
        public private(set) var title: String?
        public private(set) var costUSD: Double?
        public private(set) var fiveHourLimit: UsageLimit?
        public private(set) var sevenDayLimit: UsageLimit?
        public private(set) var tokens: TokenCounts?
        public private(set) var contextTokens: Int?
        public private(set) var contextWindow: Int?
        public private(set) var model: String?
        /// Shells, monitors and agents started in the background that have not reported back.
        public private(set) var background = BackgroundTasks()
        /// API responses already in `tokens`.
        private var countedRequests: Set<String> = []

        public init() {}

        public mutating func apply(_ read: TranscriptTail.Read) {
            if read.reset {
                entries = []
                tokens = nil
                countedRequests = []
                contextTokens = nil
                background = BackgroundTasks()
            }
            for line in read.lines {
                background.read(line)
                let parsed = Transcript.parse(line)
                entries += parsed.entries
                if let title = parsed.title { self.title = title }
                if let cost = parsed.costUSD { costUSD = cost }
                if let limit = parsed.fiveHourLimit { fiveHourLimit = limit }
                if let limit = parsed.sevenDayLimit { sevenDayLimit = limit }
                if let window = parsed.contextWindow { contextWindow = window }
                if let model = parsed.model { self.model = model }
                if parsed.compacted { contextTokens = 0 }
                if let usage = parsed.usage { contextTokens = usage.tokens.allInput }
                if let usage = parsed.usage, countedRequests.insert(usage.requestId).inserted {
                    tokens = (tokens ?? TokenCounts()) + usage.tokens
                }
            }
            if entries.count > LocalSessions.maxEntries { entries.removeFirst(entries.count - LocalSessions.maxEntries) }
        }

        var lastMessage: String? {
            entries.last { $0.kind == .assistant || $0.kind == .user }?.text.map { String($0.prefix(200)) }
        }
    }

    /// The conversations the app shows: the relay's copy of a session, which comes with an agent that can chat, or else this
    /// Mac's transcript. The relay answers a subscription to a session it does not know with an empty history, which must
    /// not hide the transcript; nor must its latest entries (`partial`), sent before the rest of its history.
    public static func entries(local: [String: [Entry]], relay: [String: [Entry]], partial: Set<String> = []) -> [String: [Entry]] {
        local.merging(relay.filter { !partial.contains($0.key) || local[$0.key]?.isEmpty != false }) { local, relay in
            relay.isEmpty ? local : relay
        }
    }

    /// The session as the notch shows it. `endedAt` is set once its process is gone.
    public static func summary(_ record: Record, _ conversation: Conversation, endedAt: Date? = nil) -> SessionSummary {
        let cwd = record.cwd.hasSuffix("/") && record.cwd.count > 1 ? String(record.cwd.dropLast()) : record.cwd
        let started = record.startedAt.map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
        let updated = record.updatedAt.map { Date(timeIntervalSince1970: $0 / 1000) } ?? started
        // Done with its turn, but a task it started in the background has yet to report back: still at work.
        let waiting = endedAt == nil && record.sessionStatus == .idle ? conversation.background.waiting() : nil
        let status: SessionStatus = endedAt != nil ? .ended : waiting != nil ? .working : record.sessionStatus
        return SessionSummary(
            id: record.sessionId, machineId: machineId, machine: "This Mac", platform: "darwin", cwd: cwd,
            project: URL(fileURLWithPath: cwd).lastPathComponent, title: conversation.title,
            status: status, statusText: waiting, agentOnline: true, canChat: false,
            pendingPermissions: [], costUSD: conversation.costUSD, startedAt: started, lastActivity: endedAt ?? updated,
            lastMessage: conversation.lastMessage, fiveHourLimit: conversation.fiveHourLimit,
            sevenDayLimit: conversation.sevenDayLimit, tokens: conversation.tokens,
            context: conversation.contextTokens.map { ContextUsage(usedTokens: $0, windowTokens: conversation.contextWindow) },
            model: conversation.model)
    }
}
