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
    public let startedAt: Date
    public let lastActivity: Date
    public let lastMessage: String?

    public init(
        id: String, machineId: String, machine: String, platform: String?, cwd: String, project: String, title: String?,
        status: SessionStatus,
        statusText: String?, agentOnline: Bool, canChat: Bool, pendingPermissions: [PermissionRequest], costUSD: Double?,
        startedAt: Date, lastActivity: Date, lastMessage: String?
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
    }

    /// Claude Code's notification texts, shortened for the notch.
    public var displayStatusText: String {
        guard let text = statusText, !text.isEmpty else { return status.label }
        if let range = text.range(of: "needs your permission to use ") { return "Wants to use \(text[range.upperBound...])" }
        if text.contains("waiting for your input") { return "Waiting for you" }
        return text
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
