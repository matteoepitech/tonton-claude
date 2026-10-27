import Foundation

// Mirrors shared/protocol.ts. Fields named `blob`, `info`, `meta`, `statusDetail` and `name` are sealed (see E2E).

public struct WirePermission: Decodable, Equatable, Sendable {
    public let requestId: String
    public let ts: String
    public let blob: String
}

public struct WireSession: Decodable, Sendable {
    public let id: String
    public let machineId: String
    public let status: SessionStatus
    public let agentOnline: Bool
    public let canChat: Bool
    public let info: String?
    public let meta: String?
    public let statusDetail: String?
    public let pendingPermissions: [WirePermission]
    public let startedAt: String
    public let lastActivity: String
    /// Sealed `SessionName`. Missing from older relays, and until a Mac renames the session.
    public var name: String? = nil
}

public struct WireEntry: Decodable, Sendable {
    public let id: String
    public let ts: String
    public let blob: String
}

public struct WireMachine: Decodable, Sendable {
    public let id: String
    public let name: String
    public let createdAt: String
    public let lastSeen: String?
    public let online: Bool
    public let agentVersion: String?
    /// Sealed `MachineHealth`. Missing from older relays.
    public let health: String?
}

/// Messages the relay sends to the app.
public enum RelayMessage: Decodable, Sendable {
    case snapshot(sessions: [WireSession], machines: [WireMachine])
    case session(WireSession)
    case removed(sessionId: String)
    case machines([WireMachine])
    case history(sessionId: String, entries: [WireEntry])
    /// The latest entries only, sent first to an app that subscribed with `latestFirst`: the whole `history` follows.
    case recentHistory(sessionId: String, entries: [WireEntry])
    case entries(sessionId: String, entries: [WireEntry])
    case error(String)
    /// `reason` when the relay could not reach the agent, `detail` (sealed) when the agent tried and failed.
    case agentUpdate(machineId: String, ok: Bool, reason: String?, detail: String?)
    /// Where a start from the notch stands. `detail` is a sealed `StartDetail`, `reason` set when the relay could not
    /// reach the machine.
    case sessionStart(machineId: String, launchId: String, state: String, reason: String?, detail: String?)
    /// A machine's answer to a request for its log: `logs` is a sealed `AgentLog`, `reason` set when the relay could not
    /// reach the machine.
    case agentLogs(machineId: String, requestId: String, reason: String?, logs: String?)
    /// A machine's answer to a request for a diagnosis: `diagnosis` is a sealed `Diagnosis`, `reason` set when the relay
    /// could not reach the machine.
    case diagnosis(machineId: String, requestId: String, reason: String?, diagnosis: String?)
    /// A pool's message (docs/pools.md), unopened: each pool has its own key. One the app cannot read is `unknown`.
    case pool(PoolUpdate)
    case unknown

    private enum Keys: String, CodingKey {
        case t, sessions, machines, session, sessionId, entries, message, machineId, ok, reason, detail, launchId, state
        case requestId, logs, diagnosis, partial
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        func value<T: Decodable>(_ key: Keys) throws -> T { try container.decode(T.self, forKey: key) }
        func optional(_ key: Keys) throws -> String? { try container.decodeIfPresent(String.self, forKey: key) }
        let t = try container.decode(String.self, forKey: .t)
        if t.hasPrefix("pool_") {
            self = (try? PoolUpdate(from: decoder)).map(RelayMessage.pool) ?? .unknown
            return
        }
        switch t {
        case "snapshot":
            self = .snapshot(sessions: try value(.sessions), machines: try value(.machines))
        case "session": self = .session(try value(.session))
        case "removed": self = .removed(sessionId: try value(.sessionId))
        case "machines": self = .machines(try value(.machines))
        case "history":
            let (sessionId, entries): (String, [WireEntry]) = (try value(.sessionId), try value(.entries))
            let partial = try container.decodeIfPresent(Bool.self, forKey: .partial) == true
            self = partial ? .recentHistory(sessionId: sessionId, entries: entries) : .history(sessionId: sessionId, entries: entries)
        case "entries": self = .entries(sessionId: try value(.sessionId), entries: try value(.entries))
        case "error": self = .error(try value(.message))
        case "agent_update":
            let (reason, detail) = (try optional(.reason), try optional(.detail))
            self = .agentUpdate(machineId: try value(.machineId), ok: try value(.ok), reason: reason, detail: detail)
        case "session_start":
            let (reason, detail) = (try optional(.reason), try optional(.detail))
            self = .sessionStart(
                machineId: try value(.machineId), launchId: try value(.launchId), state: try value(.state), reason: reason,
                detail: detail)
        case "agent_logs":
            let (reason, logs) = (try optional(.reason), try optional(.logs))
            self = .agentLogs(machineId: try value(.machineId), requestId: try value(.requestId), reason: reason, logs: logs)
        case "diagnosis":
            let (reason, diagnosis) = (try optional(.reason), try optional(.diagnosis))
            self = .diagnosis(machineId: try value(.machineId), requestId: try value(.requestId), reason: reason, diagnosis: diagnosis)
        default: self = .unknown
        }
    }
}

// Plaintext payloads inside sealed fields.

struct SessionInfo: Codable {
    let machine: String
    let platform: String?
    let cwd: String
    let project: String
    /// Missing for Claude Code, and from older agents.
    var tool: String? = nil
}
struct SessionMeta: Codable {
    let title: String?
    let costUSD: Double?
    let lastMessage: String?
    var fiveHourLimit: WireUsageLimit?
    var sevenDayLimit: WireUsageLimit?
    var tokens: TokenCounts?
    var context: WireContext?
    /// Missing from older agents.
    var terminal: Bool?
    /// The commands the agent runs for this session. Missing from older agents: `compact` and `clear` with `terminal`.
    var commands: [String]?
    /// The model's API id. Missing from older agents.
    var model: String?
    /// The git branch of the session folder. Missing outside git and from older agents.
    var branch: String?
    /// The latest task list's progress, while it has one. Missing from older agents.
    var tasks: TaskProgress?
    /// The last turns that ended, oldest first. Missing from older agents.
    var turns: [WireTurn]?
}
struct WireTurn: Codable { let end: String; let seconds: Double }
struct WireContext: Codable { let usedTokens: Int; let windowTokens: Int? }
struct WireUsageLimit: Codable { let usedPercent: Double; let resetsAt: String }
struct StatusDetail: Codable { let text: String }
struct PermissionDetail: Codable { let toolName: String; let description: String; let inputPreview: String }
struct MachineName: Codable { let name: String; let platform: String? }

public struct OutgoingImage: Codable, Sendable {
    public let name: String
    public let mediaType: String
    public let data: String

    public init(name: String, mediaType: String, data: String) {
        self.name = name
        self.mediaType = mediaType
        self.data = data
    }
}

struct PromptPayload: Codable {
    let text: String
    let images: [OutgoingImage]
    var command: SessionCommand?
}
struct UpdateOrder: Codable { let version: String; let issuedAt: String }
struct SessionName: Codable { let sessionId: String; let name: String; let issuedAt: String }
struct LogRequest: Codable { let requestId: String; let machineId: String; let issuedAt: String }
struct DiagnoseRequest: Codable {
    let requestId: String
    let machineId: String
    let issuedAt: String
    var fix: String?
}
struct StartOrder: Codable {
    let launchId: String
    let machineId: String
    let cwd: String
    let issuedAt: String
    /// Missing for claude: older agents only know it.
    var tool: String? = nil
}
struct StartAnswer: Codable {
    let launchId: String
    let machineId: String
    let question: String
    let confirm: Bool
    let issuedAt: String
}

/// Sealed by the agent with each report of a start: the app goes by it, not by the fields the relay can see.
public struct StartDetail: Codable, Equatable, Sendable {
    public let launchId: String
    public let machineId: String
    public let state: String
    public let text: String?
    public let question: String?
    public let sessionId: String?

    public init(
        launchId: String, machineId: String, state: String, text: String? = nil, question: String? = nil, sessionId: String? = nil
    ) {
        (self.launchId, self.machineId, self.state) = (launchId, machineId, state)
        (self.text, self.question, self.sessionId) = (text, question, sessionId)
    }
}

enum ISO8601 {
    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ string: String) -> Date? { withFraction.date(from: string) ?? plain.date(from: string) }
}
