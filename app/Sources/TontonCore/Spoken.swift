import Foundation

/// What VoiceOver says in the notch where the screen shows a shape or a symbol: the status dots, the pills, and the
/// announcement of new permission requests. It stays on this Mac, like everything decrypted.
public enum Spoken {
    /// A status dot: the state, then the 5-hour limit while its ring shows.
    public static func status(_ status: SessionStatus, limit: UsageLimit?, at now: Date = Date()) -> String {
        guard let limit, limit.level(at: now) != nil else { return status.label }
        return "\(status.label), 5-hour limit \(Int(limit.usedPercent.rounded())) % used"
    }

    /// Read out when a session asks for permissions, without moving the VoiceOver cursor.
    public static func permissions(_ requests: [PermissionRequest], session: String) -> String {
        guard requests.count == 1, let request = requests.first else {
            return "\(session) asks for \(requests.count) permissions: \(requests.map(\.toolName).joined(separator: ", "))"
        }
        let description = request.description.trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(session) asks to use \(request.toolName)" + (description.isEmpty ? "" : ": \(description)")
    }

    /// "No live session", "1 live session", "3 live sessions".
    public static func count(_ count: Int, _ noun: String) -> String {
        count == 0 ? "No \(noun)" : "\(count) \(noun)\(count == 1 ? "" : "s")"
    }
}

extension PermissionRequest {
    /// The requests of `current` that `previous` did not have, in order: those to announce.
    public static func added(_ current: [PermissionRequest], since previous: [PermissionRequest]) -> [PermissionRequest] {
        let seen = Set(previous.map(\.requestId))
        return current.filter { !seen.contains($0.requestId) }
    }
}
