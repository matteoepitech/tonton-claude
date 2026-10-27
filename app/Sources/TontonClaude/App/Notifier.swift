import TontonCore
import UserNotifications

/// Optional macOS notifications (Settings › Notch). Clicking one opens the notch on that session.
enum Notifier {
    /// `denied` turns off the setting that asked, the notifications of Settings › Notch by default.
    static func requestAccess(denied: @escaping @MainActor () -> Void = { AppSettings.shared.systemNotifications = false }) {
        UNUserNotificationCenter.current().setNotificationCategories(PermissionNotifications.categories)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            if !granted { Task { @MainActor in denied() } }
        }
    }

    /// A permission request gets Allow and Deny buttons (PermissionNotifications).
    @MainActor
    static func post(_ session: SessionSummary, body: String) {
        if session.status == .permission, let request = session.pendingPermissions.first, let store = AppDelegate.shared?.store {
            return PermissionNotifications.shared.post(session, request: request, store: store)
        }
        post(title: "\(session.machine) · \(session.displayName)", body: body, sessionId: session.id)
    }

    /// Without a session, clicking the notification just opens the notch.
    @MainActor
    static func post(title: String, body: String, sessionId: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let sessionId {
            content.userInfo = ["sessionId": sessionId]
            content.threadIdentifier = sessionId
        }
        let request = UNNotificationRequest(
            identifier: "\(sessionId ?? "tonton")-\(Date().timeIntervalSince1970)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    /// A new version found in the background. Clicking it shows the update instead of the notch.
    @MainActor
    static func postUpdate(version: String) {
        let content = UNMutableNotificationContent()
        content.title = "Tonton Claude \(version) is available"
        content.body = "Click to see the update."
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: AppUpdater.notificationId, content: content, trigger: nil))
    }
}
