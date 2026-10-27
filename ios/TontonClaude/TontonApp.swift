import SwiftUI
import TontonCore
import UIKit
import UserNotifications

@main
struct TontonApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(delegate.store)
                .onOpenURL { url in delegate.store.open(url) }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            switch phase {
            case .active: delegate.store.activate()
            case .background: delegate.store.deactivate()
            default: break
            }
        }
    }
}

/// Owns the store, so the push callbacks UIKit sends here reach it, even when the system launches the app in the
/// background to hand over a Live Activity's token.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let store = PhoneStore()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        store.push.received(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        store.push.failed(error)
    }

    /// A permission alert for the conversation on screen stays quiet: its card is right there.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let push = PermissionPush(userInfo: notification.request.content.userInfo)
        Task { @MainActor in
            completionHandler(push != nil && push?.sessionId == store.openSession ? [] : [.banner, .list, .sound])
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let push = PermissionPush(userInfo: response.notification.request.content.userInfo)
        Task { @MainActor in
            if let push { store.show(push.sessionId) }
            completionHandler()
        }
    }
}
