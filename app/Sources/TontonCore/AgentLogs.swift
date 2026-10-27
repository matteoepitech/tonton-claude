import Foundation

/// The end of a machine's agent log (shared/protocol.ts `AgentLog`), once decrypted. It says what the agent did, never
/// what Claude wrote, and the agent takes keys and tokens out before it leaves the machine.
public struct AgentLog: MachineAnswer {
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
public typealias AgentLogRequest = MachineRequest<AgentLog>
