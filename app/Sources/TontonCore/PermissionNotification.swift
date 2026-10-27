import Foundation

/// A permission request as a macOS notification with Allow and Deny buttons, so it is answered without opening the
/// notch. The notification names the session and the request; what a button does is decided here, against the requests
/// still pending, so an answer given meanwhile in the notch or the terminal is never sent twice.
public enum PermissionNotification {
    /// Allow and Deny.
    public static let category = "tonton.permission"
    /// Allow, Allow for this session and Deny: when the card offers "Allow for this session" too.
    public static let categoryWithSessionRule = "tonton.permission.session"

    public enum Action: String, CaseIterable, Sendable {
        case allow = "tonton.permission.allow"
        case allowForSession = "tonton.permission.allow-session"
        case deny = "tonton.permission.deny"
    }

    /// One notification per request: posting it again replaces it, and it can be taken away once answered.
    public static func identifier(sessionId: String, requestId: String) -> String {
        "permission-\(sessionId)-\(requestId)"
    }

    public static func userInfo(sessionId: String, requestId: String) -> [String: String] {
        ["sessionId": sessionId, "requestId": requestId]
    }

    /// What a click on the notification does.
    public enum Decision: Equatable, Sendable {
        /// Opens the notch, on the session when there is one.
        case open(sessionId: String?)
        case answer(sessionId: String, request: PermissionRequest, Action)
        /// The request was answered elsewhere, or its session is gone: nothing to do.
        case ignore
    }

    /// `actionIdentifier` is the button, or the default action for a click on the notification itself.
    public static func decide(actionIdentifier: String, userInfo: [String: String], sessions: [SessionSummary]) -> Decision {
        let sessionId = userInfo["sessionId"]
        guard let action = Action(rawValue: actionIdentifier) else { return .open(sessionId: sessionId) }
        guard let sessionId, let requestId = userInfo["requestId"],
            let request = sessions.first(where: { $0.id == sessionId })?.pendingPermissions.first(where: { $0.requestId == requestId })
        else { return .ignore }
        return .answer(sessionId: sessionId, request: request, action)
    }

    /// Identifiers of the notifications posted for requests that are no longer pending: answered in the notch or the
    /// terminal, or closed with their session.
    public static func stale(posted: Set<String>, sessions: [SessionSummary]) -> Set<String> {
        let pending = Set(
            sessions.flatMap { session in session.pendingPermissions.map { identifier(sessionId: session.id, requestId: $0.requestId) } })
        return posted.subtracting(pending)
    }
}
