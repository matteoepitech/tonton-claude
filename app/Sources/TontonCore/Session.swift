import Foundation

public enum SessionStatus: String, Codable, Sendable {
    case starting, working, waiting, permission, idle, error, ended, offline

    public var label: String {
        switch self {
        case .starting: "Starting"
        case .working: "Working"
        case .waiting: "Waiting for you"
        case .permission: "Needs approval"
        case .idle: "Done"
        case .error: "Error"
        case .ended: "Closed"
        case .offline: "Offline"
        }
    }

    public var needsAttention: Bool { self == .waiting || self == .permission || self == .error }
    public var isLive: Bool { self != .ended && self != .offline }
}

public struct PermissionRequest: Identifiable, Equatable, Sendable {
    public let requestId: String
    public let toolName: String
    public let description: String
    public let inputPreview: String
    public let ts: String
    public var id: String { requestId }

    public init(requestId: String, toolName: String, description: String, inputPreview: String, ts: String) {
        self.requestId = requestId
        self.toolName = toolName
        self.description = description
        self.inputPreview = inputPreview
        self.ts = ts
    }
}

/// A session as the app shows it, once decrypted.
public struct SessionSummary: Identifiable, Equatable, Sendable {
    public let id: String
    public let machineId: String
    public let machine: String
    /// The agent's platform (win32, darwin, linux), when it reported one.
    public let platform: String?
    public let cwd: String
    public let project: String
    public let title: String?
    public let status: SessionStatus
    public let statusText: String?
    public let agentOnline: Bool
    public let canChat: Bool
    public let pendingPermissions: [PermissionRequest]
    public let costUSD: Double?
    /// Nil with older agents.
    public let tokens: TokenCounts?
    public let startedAt: Date
    public let lastActivity: Date
    public let lastMessage: String?
    /// The 5-hour window of the Claude plan the session runs on. Nil with an API key, and with older agents.
    public let fiveHourLimit: UsageLimit?
    /// The weekly window, like the 5-hour one.
    public let sevenDayLimit: UsageLimit?

    public init(
        id: String, machineId: String, machine: String, platform: String?, cwd: String, project: String, title: String?,
        status: SessionStatus,
        statusText: String?, agentOnline: Bool, canChat: Bool, pendingPermissions: [PermissionRequest], costUSD: Double?,
        startedAt: Date, lastActivity: Date, lastMessage: String?, fiveHourLimit: UsageLimit? = nil,
        sevenDayLimit: UsageLimit? = nil, tokens: TokenCounts? = nil
    ) {
        self.id = id
        self.machineId = machineId
        self.machine = machine
        self.platform = platform
        self.cwd = cwd
        self.project = project
        self.title = title
        self.status = status
        self.statusText = statusText
        self.agentOnline = agentOnline
        self.canChat = canChat
        self.pendingPermissions = pendingPermissions
        self.costUSD = costUSD
        self.startedAt = startedAt
        self.lastActivity = lastActivity
        self.lastMessage = lastMessage
        self.fiveHourLimit = fiveHourLimit
        self.sevenDayLimit = sevenDayLimit
        self.tokens = tokens
    }

    /// The window worth a countdown: the one that stopped the session (the last to reset when both did), or else the
    /// fullest one past 80 %. Nil while there is room.
    public func limitToWatch(at now: Date = Date()) -> UsageLimit? {
        let limits = [fiveHourLimit, sevenDayLimit].compactMap { $0 }
        let reached = limits.filter { $0.level(at: now) == .reached }
        if let last = reached.max(by: { $0.resetsAt < $1.resetsAt }) { return last }
        return limits.filter { $0.level(at: now) == .high }.max { $0.usedPercent < $1.usedPercent }
    }

    /// When a session stopped by a usage limit can go again. Nil when no limit stops it.
    public func stoppedUntil(at now: Date = Date()) -> Date? {
        guard let limit = limitToWatch(at: now), limit.level(at: now) == .reached else { return nil }
        return limit.resetsAt
    }

    /// Claude Code's notification texts, shortened for the notch.
    public var displayStatusText: String {
        guard let text = statusText, !text.isEmpty else { return status.label }
        if let range = text.range(of: "needs your permission to use ") { return "Wants to use \(text[range.upperBound...])" }
        if text.contains("waiting for your input") { return "Waiting for you" }
        // StopFailure's error type when the plan's limit refuses a request.
        if text == "rate_limit" { return "Usage limit reached" }
        return text
    }
}

/// Tokens of a session's API responses, summed from its transcript.
public struct TokenCounts: Codable, Equatable, Sendable {
    public var input: Int
    public var output: Int
    /// Input read from or written to the prompt cache, billed apart from the rest.
    public var cacheRead: Int
    public var cacheWrite: Int

    public init(input: Int = 0, output: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
    }

    /// Everything the model read, cached or not.
    public var allInput: Int { input + cacheRead + cacheWrite }

    public static func + (a: TokenCounts, b: TokenCounts) -> TokenCounts {
        TokenCounts(
            input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
            cacheWrite: a.cacheWrite + b.cacheWrite)
    }

    /// `950`, `4.2k`, `48k`, `1.2M`.
    public static func short(_ count: Int) -> String {
        func trimmed(_ value: Double) -> String { String(format: "%.1f", value).replacingOccurrences(of: ".0", with: "") }
        if count < 1000 { return "\(count)" }
        if count < 10_000 { return "\(trimmed(Double(count) / 1000))k" }
        if count < 1_000_000 { return "\(count / 1000)k" }
        return "\(trimmed(Double(count) / 1_000_000))M"
    }
}

/// How much of a Claude plan's usage window is spent.
public struct UsageLimit: Equatable, Sendable {
    /// 0 to 100.
    public let usedPercent: Double
    public let resetsAt: Date

    public init(usedPercent: Double, resetsAt: Date) {
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
    }

    public enum Level: Equatable, Sendable {
        case normal
        /// From 80 %.
        case high
        case reached
    }

    /// Nil once the window has reset: the reading says nothing about the new one.
    public func level(at now: Date = Date()) -> Level? {
        guard resetsAt > now else { return nil }
        return usedPercent >= 100 ? .reached : usedPercent >= 80 ? .high : .normal
    }

    /// The fullest window still running, for a gauge that stands for several sessions.
    public static func fullest(_ limits: [UsageLimit?], at now: Date = Date()) -> UsageLimit? {
        limits.compactMap { $0 }.filter { $0.level(at: now) != nil }.max { $0.usedPercent < $1.usedPercent }
    }

    /// Among the windows of several sessions, the one to count down to: the first one to free a stopped session, or else
    /// the first one to reset.
    public static func soonest(_ limits: [UsageLimit?], at now: Date = Date()) -> UsageLimit? {
        let running = limits.compactMap { $0 }.filter { $0.level(at: now) != nil }
        let reached = running.filter { $0.level(at: now) == .reached }
        return (reached.isEmpty ? running : reached).min { $0.resetsAt < $1.resetsAt }
    }

    /// `1 h 42`, `42 min` or `2 d 5 h` until the reset, at least a minute.
    public func timeLeft(at now: Date = Date()) -> String {
        let minutes = max(1, Int((resetsAt.timeIntervalSince(now) / 60).rounded(.up)))
        if minutes < 60 { return "\(minutes) min" }
        if minutes < 24 * 60 { return "\(minutes / 60) h \(String(format: "%02d", minutes % 60))" }
        let hours = minutes / 60
        return hours % 24 == 0 ? "\(hours / 24) d" : "\(hours / 24) d \(hours % 24) h"
    }
}

/// When the sessions a usage limit stopped can go again.
public enum LimitResets {
    /// The reset times still to come among the live sessions a limit stopped.
    public static func upcoming(_ sessions: [SessionSummary], at now: Date = Date()) -> Set<Date> {
        Set(sessions.filter(\.status.isLive).compactMap { $0.stoppedUntil(at: now) })
    }

    /// The live sessions that `reset` frees: the ones stopped until then, read just before it.
    public static func lifted(_ sessions: [SessionSummary], at reset: Date) -> [SessionSummary] {
        sessions.filter { $0.status.isLive && $0.stoppedUntil(at: reset.addingTimeInterval(-1)) == reset }
    }

    /// Among freed sessions, the ones to send `continue` to: those the user asked for that still take messages.
    public static func toContinue(_ lifted: [SessionSummary], optedIn: Set<String>) -> [String] {
        lifted.filter { optedIn.contains($0.id) && $0.canChat && $0.status.isLive }.map(\.id)
    }
}

public struct MachineInfo: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let platform: String?
    public let createdAt: Date
    public let lastSeen: Date?
    public let online: Bool
    /// Installed agent version. Unknown for agents older than 0.4.0, and for machines not seen since the relay started.
    public let agentVersion: String?

    public init(id: String, name: String, platform: String?, createdAt: Date, lastSeen: Date?, online: Bool, agentVersion: String?) {
        self.id = id
        self.name = name
        self.platform = platform
        self.createdAt = createdAt
        self.lastSeen = lastSeen
        self.online = online
        self.agentVersion = agentVersion
    }

    public enum AgentUpdate: Equatable, Sendable {
        /// The agent updates itself when asked.
        case oneClick
        /// The agent is too old to update itself: the install command must run once more on the machine.
        case manual
    }

    /// How the machine's agent can be brought to `latest`, nil when it is up to date or its version is unknown.
    public func agentUpdate(to latest: String?) -> AgentUpdate? {
        guard let latest else { return nil }
        guard let agentVersion else { return online ? .manual : nil }
        return agentVersion.compare(latest, options: .numeric) == .orderedAscending ? .oneClick : nil
    }
}
