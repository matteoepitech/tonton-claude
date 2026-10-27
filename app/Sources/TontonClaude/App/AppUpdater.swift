import AppKit
import Combine
import OSLog
import Sparkle
import TontonCore
import UserNotifications

/// Updates of the app itself (Settings › General), with Sparkle, from the appcast published with each release. Builds
/// without the feed's key (see UpdateFeed) never start it, and show nothing about updates.
@MainActor
final class AppUpdater: NSObject, ObservableObject {
    static let shared = AppUpdater()
    /// The notification of an update found in the background, removed once the user has seen the update.
    nonisolated static let notificationId = "tonton-update"

    @Published private(set) var isOn = false
    /// False while a check or an update is running.
    @Published private(set) var canCheck = false

    private var controller: SPUStandardUpdaterController?
    private var subscriptions = Set<AnyCancellable>()

    /// Daily, as long as the user leaves it on; Sparkle keeps the choice.
    var checksAutomatically: Bool {
        get { controller?.updater.automaticallyChecksForUpdates ?? false }
        set {
            objectWillChange.send()
            controller?.updater.automaticallyChecksForUpdates = newValue
        }
    }

    func start() {
        guard controller == nil, let feed = UpdateFeed(info: Bundle.main.infoDictionary ?? [:]) else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: self)
        do {
            try controller.updater.start()
        } catch {
            Logger.app.error("updates from \(feed.url, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return
        }
        self.controller = controller
        isOn = true
        controller.updater.publisher(for: \.canCheckForUpdates).receive(on: RunLoop.main).sink { [weak self] can in
            self?.canCheck = can
        }
        .store(in: &subscriptions)
    }

    /// Also brings an update found in the background to the front.
    func checkForUpdates() {
        controller?.updater.checkForUpdates()
    }
}

/// Sparkle's gentle reminders for an app without a Dock icon: its update window would show up behind the other apps,
/// with nothing to bring it back. While an update is on screen the app gets a Dock icon, and one found in the background
/// adds a badge and a notification.
extension AppUpdater: SPUStandardUserDriverDelegate {
    nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }

    nonisolated func standardUserDriverWillHandleShowingUpdate(
        _ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState
    ) {
        let version = update.displayVersionString
        let inBackground = !state.userInitiated
        MainActor.assumeIsolated {
            NSApp.setActivationPolicy(.regular)
            guard inBackground else { return }
            NSApp.dockTile.badgeLabel = "1"
            if AppSettings.shared.systemNotifications { Notifier.postUpdate(version: version) }
        }
    }

    nonisolated func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) {
        MainActor.assumeIsolated {
            NSApp.dockTile.badgeLabel = nil
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [AppUpdater.notificationId])
        }
    }

    nonisolated func standardUserDriverWillFinishUpdateSession() {
        MainActor.assumeIsolated {
            NSApp.dockTile.badgeLabel = nil
            NSApp.setActivationPolicy(.accessory)
        }
    }
}
