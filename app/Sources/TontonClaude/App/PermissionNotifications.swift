import Combine
import TontonCore
import UserNotifications

/// Permission requests as macOS notifications with Allow and Deny, and Allow for this session when the card offers it.
/// A button answers like the card does, for relay sessions and this Mac's OpenCode sessions alike, and the notification
/// goes away once the request is answered anywhere else.
@MainActor
final class PermissionNotifications {
    static let shared = PermissionNotifications()

    /// Notifications posted for requests, until they close.
    private var posted: Set<String> = []
    private var watching: AnyCancellable?

    /// Registered with the notification center along with the request for access.
    nonisolated static var categories: Set<UNNotificationCategory> {
        let allow = UNNotificationAction(
            identifier: PermissionNotification.Action.allow.rawValue, title: String(localized: "Allow"), options: [.authenticationRequired])
        let session = UNNotificationAction(
            identifier: PermissionNotification.Action.allowForSession.rawValue, title: String(localized: "Allow for this session"),
            options: [.authenticationRequired])
        let deny = UNNotificationAction(
            identifier: PermissionNotification.Action.deny.rawValue, title: String(localized: "Deny"), options: [.destructive])
        return [
            UNNotificationCategory(identifier: PermissionNotification.category, actions: [allow, deny], intentIdentifiers: []),
            UNNotificationCategory(
                identifier: PermissionNotification.categoryWithSessionRule, actions: [allow, session, deny], intentIdentifiers: []),
        ]
    }

    /// The session's first pending request, with its buttons. One notification per request: posting again replaces it.
    func post(_ session: SessionSummary, request: PermissionRequest, store: SessionStore) {
        let content = UNMutableNotificationContent()
        content.title = "\(session.machine) · \(session.displayName)"
        content.subtitle = String(localized: "Allow \(request.toolName)?")
        content.body = String(request.description.prefix(200))
        content.userInfo = PermissionNotification.userInfo(sessionId: session.id, requestId: request.requestId)
        content.threadIdentifier = session.id
        content.categoryIdentifier =
            store.sessionRule(for: request, in: session) == nil
            ? PermissionNotification.category : PermissionNotification.categoryWithSessionRule
        let identifier = PermissionNotification.identifier(sessionId: session.id, requestId: request.requestId)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
        posted.insert(identifier)
        watch(store)
    }

    /// What a click on a notification does, whichever kind it is.
    func handle(actionIdentifier: String, userInfo: [String: String], store: SessionStore, open: (String?) -> Void) {
        switch PermissionNotification.decide(actionIdentifier: actionIdentifier, userInfo: userInfo, sessions: store.sessions) {
        case .open(let sessionId): open(sessionId)
        case .ignore: break
        case .answer(let sessionId, let request, .allow): store.answer(request, allow: true, in: sessionId)
        case .answer(let sessionId, let request, .deny): store.answer(request, allow: false, in: sessionId)
        case .answer(let sessionId, let request, .allowForSession):
            // The agent may have gone older or offline since: then it allows the one call, as Allow does.
            if let session = store.sessions.first(where: { $0.id == sessionId }), let rule = store.sessionRule(for: request, in: session) {
                store.allowForSession(request, rule: rule, in: sessionId)
            } else {
                store.answer(request, allow: true, in: sessionId)
            }
        }
    }

    /// Answered in the notch, in the terminal or by an auto-approve rule: the notification has nothing left to ask.
    private func watch(_ store: SessionStore) {
        guard watching == nil else { return }
        watching = store.sessionsPublisher.sink { [weak self] sessions in
            guard let self else { return }
            let stale = PermissionNotification.stale(posted: posted, sessions: sessions)
            guard !stale.isEmpty else { return }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(stale))
            posted.subtract(stale)
        }
    }
}
