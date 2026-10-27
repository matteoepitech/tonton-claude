import TontonCore
import UserNotifications

/// Writes the real text of a permission alert. The relay sends the same words for every request with the request and
/// its session sealed beside them; they are opened here, on the phone, with the account key. When they don't open
/// (signed out, another account, a relay that left them out) the generic text stays.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(
        _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        if let push = PermissionPush(userInfo: content.userInfo), let alert = SharedAccount.vault()?.alert(for: push) {
            content.title = alert.title
            content.subtitle = alert.subtitle
            content.body = alert.body
        }
        contentHandler(content)
    }
}
