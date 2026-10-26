import Foundation

/// The end of a machine's agent log (shared/protocol.ts `AgentLog`), once decrypted. It says what the agent did, never
/// what Claude wrote, and the agent takes keys and tokens out before it leaves the machine.
public struct AgentLog: Codable, Equatable, Sendable {
    public let requestId: String
    public let machineId: String
    /// Oldest first.
    public let lines: [String]
    /// Earlier lines were left out.
    public let truncated: Bool
    /// Of the whole log file, in bytes.
    public let size: Int
    public let at: String
    /// Why the agent sent no lines.
    public let error: String?

    public init(
        requestId: String, machineId: String, lines: [String], truncated: Bool = false, size: Int = 0, at: String, error: String? = nil
    ) {
        (self.requestId, self.machineId, self.lines, self.truncated) = (requestId, machineId, lines, truncated)
        (self.size, self.at, self.error) = (size, at, error)
    }

    public var readAt: Date? { ISO8601.parse(at) }
}

/// One line of the log, as the agent writes it: `2026-10-26T12:00:00.000Z [4242] service started {"version":"0.5.0"}`.
/// Lines written some other way keep all their text as the message.
public struct AgentLogLine: Equatable, Sendable {
    public let date: Date?
    public let pid: Int?
    public let message: String

    public init(_ raw: String) {
        let parts = raw.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, let date = ISO8601.parse(String(parts[0])), parts[1].hasPrefix("["), parts[1].hasSuffix("]"),
            let pid = Int(parts[1].dropFirst().dropLast())
        else {
            (self.date, self.pid, self.message) = (nil, nil, raw)
            return
        }
        (self.date, self.pid, self.message) = (date, pid, String(parts[2]))
    }
}

/// A request for a machine's agent log, from the click in Settings › Machines to the answer.
public struct AgentLogRequest: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case loading
        case loaded(AgentLog)
        case failed(String)
    }

    public let id: String
    public let machineId: String
    public let state: State
    /// The log shown before this request, kept on screen while it loads.
    public let previous: AgentLog?

    public init(id: String = SessionLaunch.newId(), machineId: String, state: State = .loading, previous: AgentLog? = nil) {
        (self.id, self.machineId, self.state, self.previous) = (id, machineId, state, previous)
    }

    /// The request once the relay answered. Only a log sealed for this request and this machine counts: the relay could
    /// hand back an older one, or another machine's.
    public func received(reason: String?, log: AgentLog?, machine: String) -> AgentLogRequest {
        guard state == .loading else { return self }
        if reason == "offline" { return failed("\(machine) is offline. Check that it is on and that the Tonton Claude agent runs there.") }
        guard let log, log.requestId == id, log.machineId == machineId else { return self }
        if let error = log.error { return failed(error) }
        return AgentLogRequest(id: id, machineId: machineId, state: .loaded(log), previous: previous)
    }

    public func failed(_ text: String) -> AgentLogRequest {
        AgentLogRequest(id: id, machineId: machineId, state: .failed(text), previous: previous)
    }

    /// What to show: this request's log, or the previous one until it comes.
    public var log: AgentLog? {
        if case .loaded(let log) = state { return log }
        return previous
    }

    public var isLoading: Bool { state == .loading }
}
