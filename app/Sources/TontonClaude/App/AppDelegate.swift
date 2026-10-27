import AppKit
import Combine
import TontonCore
import UserNotifications

/// Composition root: builds the store, the notch, the settings window and the menu bar item, and routes app-level events.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static weak var shared: AppDelegate?

    private let settings = AppSettings.shared
    /// Also read by the AppleScript commands.
    private(set) lazy var store = SessionStore(settings: settings)
    private var notch: NotchWindowController?
    private var webhooks: WebhookNotifier?
    private var widgets: WidgetPublisher?
    private var dailySummary: DailySummaryNotifier?
    private var achievements: AchievementTracker?
    private lazy var settingsWindow = SettingsWindowController(store: store, settings: settings)
    private let whatsNew = WhatsNewWindowController()
    private lazy var statusItem = StatusItemController(
        updater: .shared,
        onToggleNotch: { [weak self] in self?.notch?.toggle() },
        onReconnect: { [weak self] in self?.store.connect() },
        onSettings: { [weak self] in self?.showSettings() }
    )
    private var hotKey: HotKey?
    /// Links can arrive before launch finishes, when a tonton:// link starts the app.
    private var pendingLinks: [DeepLink] = []
    private var subscriptions = Set<AnyCancellable>()

    /// Messages still held for Undo send go before the app quits, with a moment for the socket to send them.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard HeldMessages.shared.flush() else { return .terminateNow }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        MainMenu.install()
        // First: the menu bar icon's menu is built once, with or without its update item.
        AppUpdater.shared.start()
        notch = NotchWindowController(store: store, settings: settings)
        MessageQueues.shared.attach(store)
        HeldMessages.shared.attach(store)
        // Messages held for Undo send go once the notch closes: their Undo button is gone with it.
        notch?.state.$mode.filter { $0 == .collapsed }.sink { _ in HeldMessages.shared.flush() }.store(in: &subscriptions)
        webhooks = WebhookNotifier(store: store, settings: settings)
        widgets = WidgetPublisher(store: store, settings: settings)
        dailySummary = DailySummaryNotifier(store: store, settings: settings)
        if let notch { achievements = AchievementTracker(store: store, notch: notch.state, settings: settings) }
        UNUserNotificationCenter.current().delegate = self

        settings.$showMenuBarIcon.sink { [weak self] visible in self?.statusItem.setVisible(visible) }.store(in: &subscriptions)
        settings.$hotkey.sink { [weak self] preset in self?.registerHotKey(preset) }.store(in: &subscriptions)
        settings.$systemNotifications.removeDuplicates().filter { $0 }.sink { _ in Notifier.requestAccess() }.store(in: &subscriptions)
        // The summary is a notification too: without the permission, the setting goes back off.
        settings.$dailySummary.removeDuplicates().filter { $0 }
            .sink { _ in Notifier.requestAccess { AppSettings.shared.dailySummary = false } }
            .store(in: &subscriptions)

        store.connect()
        let welcomed = UserDefaults.standard.bool(forKey: "welcomed")
        // Once, to introduce the app: this Mac's sessions work without an account, so it is not a requirement.
        if !settings.isConfigured && !welcomed { showSettings() }
        UserDefaults.standard.set(true, forKey: "welcomed")
        // Versions before 0.6.0 kept no `welcomed`, but a configured app ran before.
        showWhatsNewAfterUpdate(ranBefore: welcomed || settings.isConfigured)
        pendingLinks.forEach(open)
        pendingLinks = []
    }

    func applicationWillTerminate(_ notification: Notification) {
        widgets?.stop()
        // Pages opened from the archive are plain text.
        store.archive.removePages()
    }

    /// Reopening the app (Spotlight, Finder, Dock) shows the settings: the way back when the menu bar icon is hidden.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showSettings()
        return false
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        let links = urls.compactMap(DeepLink.init)
        if notch == nil { pendingLinks += links } else { links.forEach(open) }
    }

    static var version: String? { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String }

    func showWhatsNew() {
        guard let version = Self.version else { return }
        whatsNew.show(version: version)
    }

    /// The notes of a new version, once. A launch that can't reach GitHub tries again next time.
    private func showWhatsNewAfterUpdate(ranBefore: Bool) {
        guard let version = Self.version else { return }
        switch WhatsNew.atLaunch(current: version, shown: settings.whatsNewVersion, ranBefore: ranBefore, enabled: settings.showWhatsNew) {
        case .show:
            Task { if await whatsNew.showAfterUpdate(version: version) != .unreachable { settings.whatsNewVersion = version } }
        case .record: settings.whatsNewVersion = version
        case .nothing: break
        }
    }

    func showSettings(pane: SettingsPane? = nil) {
        settingsWindow.show(pane: pane)
        notch?.collapse(force: true)
    }

    func openNotchFromSettings() {
        settingsWindow.close()
        notch?.expand()
    }

    private func open(_ link: DeepLink) {
        guard let notch else { return }
        switch link {
        case .open: notch.expand()
        case .pin:
            notch.state.pinned = true
            notch.expand()
        case .close: notch.collapse(force: true)
        case .toggle: notch.toggle()
        case .settings(let pane): showSettings(pane: pane)
        case .session(let id):
            store.selectedId = id
            notch.expand()
        }
    }

    private func registerHotKey(_ preset: HotKeyPreset) {
        hotKey = preset.carbon.map { carbon in
            HotKey(keyCode: carbon.keyCode, modifiers: carbon.modifiers) { [weak self] in
                Task { @MainActor in self?.notch?.toggle() }
            }
        }
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    /// Clicking a notification opens the notch on its session, or shows the update it announces.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let isUpdate = response.notification.request.identifier == AppUpdater.notificationId
        let sessionId = response.notification.request.content.userInfo["sessionId"] as? String
        Task { @MainActor in
            guard !isUpdate else { return AppUpdater.shared.checkForUpdates() }
            if let sessionId { self.store.selectedId = sessionId }
            self.notch?.expand()
        }
        completionHandler()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
