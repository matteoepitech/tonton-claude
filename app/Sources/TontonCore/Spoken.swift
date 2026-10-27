import Foundation

/// What VoiceOver says in the notch where the screen shows a shape or a symbol: the status dots, the pills, and the
/// announcement of new permission requests. It stays on this Mac, like everything decrypted.
public enum Spoken {
    /// A status dot: the state, then the 5-hour limit while its ring shows.
    public static func status(_ status: SessionStatus, limit: UsageLimit?, at now: Date = Date()) -> String {
        guard let limit, limit.level(at: now) != nil else { return status.label }
        return String(core: "\(status.label), 5-hour limit \(Int(limit.usedPercent.rounded())) % used")
    }

    /// Read out when a session asks for permissions, without moving the VoiceOver cursor.
    public static func permissions(_ requests: [PermissionRequest], session: String) -> String {
        guard requests.count == 1, let request = requests.first else {
            let tools = requests.map(\.toolName).joined(separator: ", ")
            return String(core: "\(session) asks for \(requests.count) permissions: \(tools)")
        }
        let description = request.description.trimmingCharacters(in: .whitespacesAndNewlines)
        if description.isEmpty { return String(core: "\(session) asks to use \(request.toolName)") }
        return String(core: "\(session) asks to use \(request.toolName): \(description)")
    }

    /// The live sessions behind the closed notch's dots: "No live session", "1 live session", "3 live sessions".
    public static func liveSessions(_ count: Int) -> String {
        count == 0 ? String(core: "No live session") : String(core: "\(count) live sessions")
    }

    /// The sessions a pill row has no room for.
    public static func moreSessions(_ count: Int) -> String {
        String(core: "\(count) more sessions")
    }
}

extension PermissionRequest {
    /// The requests of `current` that `previous` did not have, in order: those to announce.
    public static func added(_ current: [PermissionRequest], since previous: [PermissionRequest]) -> [PermissionRequest] {
        let seen = Set(previous.map(\.requestId))
        return current.filter { !seen.contains($0.requestId) }
    }
}
