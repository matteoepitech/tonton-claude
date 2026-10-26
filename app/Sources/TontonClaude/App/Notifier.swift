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
        let content = UNMutableNotificationContent()
        content.title = "\(session.machine) · \(session.project)"
        content.body = body
        content.userInfo = ["sessionId": session.id]
        content.threadIdentifier = session.id
        let request = UNNotificationRequest(identifier: "\(session.id)-\(Date().timeIntervalSince1970)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
