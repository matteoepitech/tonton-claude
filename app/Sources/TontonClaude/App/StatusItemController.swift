import AppKit

/// The optional menu bar item (Settings › General › Menu bar icon).
@MainActor
final class StatusItemController: NSObject {
    private var item: NSStatusItem?
    private let updater: AppUpdater
    private let onToggleNotch: () -> Void
    private let onReconnect: () -> Void
    private let onSettings: () -> Void

    init(updater: AppUpdater, onToggleNotch: @escaping () -> Void, onReconnect: @escaping () -> Void, onSettings: @escaping () -> Void) {
        self.updater = updater
        self.onToggleNotch = onToggleNotch
        self.onReconnect = onReconnect
        self.onSettings = onSettings
    }

    func setVisible(_ visible: Bool) {
        if !visible {
            if let item { NSStatusBar.system.removeStatusItem(item) }
            item = nil
            return
        }
        guard item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = MenuBarIcon.image
        item.menu = makeMenu()
        self.item = item
    }

    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(entry("Open the notch", #selector(toggleNotch)))
        menu.addItem(entry("Reconnect", #selector(reconnect)))
        menu.addItem(.separator())
        menu.addItem(entry("Settings…", #selector(settings), key: ","))
        if updater.isOn { menu.addItem(entry("Check for Updates…", #selector(checkForUpdates))) }
        menu.addItem(.separator())
        menu.addItem(
            NSMenuItem(title: String(localized: "Quit Tonton Claude"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        return menu
    }

    private func entry(_ title: String.LocalizationValue, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: String(localized: title), action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func toggleNotch() { onToggleNotch() }
    @objc private func reconnect() { onReconnect() }
    @objc private func settings() { onSettings() }
    @objc private func checkForUpdates() { updater.checkForUpdates() }
}

extension StatusItemController: NSMenuItemValidation {
    /// Greyed out while a check or an update runs.
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        menuItem.action != #selector(checkForUpdates) || updater.canCheck
    }
}
