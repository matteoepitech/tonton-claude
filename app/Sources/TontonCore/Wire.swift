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
}

/// Messages the relay sends to the app.
public enum RelayMessage: Decodable, Sendable {
    /// `latestAgentVersion` is the agent the relay offers, missing on relays that predate agent updates.
    case snapshot(sessions: [WireSession], machines: [WireMachine], latestAgentVersion: String?)
    case session(WireSession)
    case removed(sessionId: String)
    case machines([WireMachine], latestAgentVersion: String?)
    case history(sessionId: String, entries: [WireEntry])
    case entries(sessionId: String, entries: [WireEntry])
    case error(String)
    /// `reason` when the relay could not reach the agent, `detail` (sealed) when the agent tried and failed.
    case agentUpdate(machineId: String, ok: Bool, reason: String?, detail: String?)
    case unknown

    private enum Keys: String, CodingKey {
        case t, sessions, machines, session, sessionId, entries, message, latestAgentVersion, machineId, ok, reason, detail
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        func value<T: Decodable>(_ key: Keys) throws -> T { try container.decode(T.self, forKey: key) }
        func optional(_ key: Keys) throws -> String? { try container.decodeIfPresent(String.self, forKey: key) }
        switch try container.decode(String.self, forKey: .t) {
        case "snapshot":
            let latest = try optional(.latestAgentVersion)
            self = .snapshot(sessions: try value(.sessions), machines: try value(.machines), latestAgentVersion: latest)
        case "session": self = .session(try value(.session))
        case "removed": self = .removed(sessionId: try value(.sessionId))
        case "machines":
            self = .machines(try value(.machines), latestAgentVersion: try optional(.latestAgentVersion))
        case "history": self = .history(sessionId: try value(.sessionId), entries: try value(.entries))
        case "entries": self = .entries(sessionId: try value(.sessionId), entries: try value(.entries))
        case "error": self = .error(try value(.message))
        case "agent_update":
            let (reason, detail) = (try optional(.reason), try optional(.detail))
            self = .agentUpdate(machineId: try value(.machineId), ok: try value(.ok), reason: reason, detail: detail)
        default: self = .unknown
        }
    }
}

// Plaintext payloads inside sealed fields.

struct SessionInfo: Codable { let machine: String; let platform: String?; let cwd: String; let project: String }
struct SessionMeta: Codable { let title: String?; let costUSD: Double?; let lastMessage: String? }
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

struct PromptPayload: Codable { let text: String; let images: [OutgoingImage] }
struct UpdateOrder: Codable { let version: String; let issuedAt: String }

enum ISO8601 {
    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ string: String) -> Date? { withFraction.date(from: string) ?? plain.date(from: string) }
}
