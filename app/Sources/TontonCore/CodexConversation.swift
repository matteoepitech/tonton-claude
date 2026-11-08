import Foundation

/// What one Codex rollout has said so far, as the Mac shows a session that no agent reports: like the conversation of a
/// Claude Code transcript (`LocalSessions.Conversation`), read with `CodexRollout`.
public struct CodexConversation {
    /// Like the agent's backlog: older entries are dropped.
    static let maxEntries = 400

    public private(set) var entries: [Entry] = []
    /// The first prompt; a name the user gave the thread comes from Codex's index instead.
    public private(set) var title: String?
    public private(set) var tokens: TokenCounts?
    public private(set) var contextTokens: Int?
    public private(set) var contextWindow: Int?
    public private(set) var model: String?
    /// The ChatGPT plan's windows, as Codex last read them.
    public private(set) var fiveHourLimit: UsageLimit?
    public private(set) var sevenDayLimit: UsageLimit?
    /// A turn started and has not ended.
    public private(set) var working = false
    private var rollout = CodexRollout()
    /// Responses already in `tokens`.
    private var countedRequests: Set<String> = []

    public init() {}

    public mutating func apply(_ read: TranscriptTail.Read) {
        if read.reset { self = CodexConversation() }
        for line in read.lines {
            let parsed = rollout.line(line)
            entries += parsed.entries
            if let title = parsed.title { self.title = title }
            if let model = parsed.model { self.model = model }
            if let window = parsed.contextWindow { contextWindow = window }
            if let status = parsed.status { working = status == .working }
            if let windows = parsed.planWindows { (fiveHourLimit, sevenDayLimit) = (windows.fiveHour, windows.sevenDay) }
            if parsed.compacted { contextTokens = 0 }
            if let usage = parsed.usage {
                contextTokens = usage.tokens.allInput
                if countedRequests.insert(usage.requestId).inserted { tokens = (tokens ?? TokenCounts()) + usage.tokens }
            }
        }
        if entries.count > Self.maxEntries { entries.removeFirst(entries.count - Self.maxEntries) }
    }

    /// The last prompt or answer, for the session list.
    public var lastMessage: String? {
        entries.last { $0.kind == .assistant || $0.kind == .user }?.text.map { String($0.prefix(200)) }
    }
}
