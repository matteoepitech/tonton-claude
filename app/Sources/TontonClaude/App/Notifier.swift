import TontonCore
import UserNotifications

/// Optional macOS notifications (Settings › Notch). Clicking one opens the notch on that session.
enum Notifier {
    static func requestAccess() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            if !granted { DispatchQueue.main.async { AppSettings.shared.systemNotifications = false } }
        }
    }

    @MainActor
    static func post(_ session: SessionSummary, body: String) {
        post(title: "\(session.machine) · \(session.project)", body: body, sessionId: session.id)
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
}
