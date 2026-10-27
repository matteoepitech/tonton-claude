import AppKit

/// The app shows a menu bar only while an update is on screen (AppUpdater), but text fields only get ⌘C, ⌘V, ⌘X, ⌘A and
/// ⌘Z through the key equivalents of an Edit menu.
enum MainMenu {
    @MainActor
    static func install() {
        let edit = NSMenu(title: String(localized: "Edit"))
        edit.addItem(withTitle: String(localized: "Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: String(localized: "Redo"), action: Selector(("redo:")), keyEquivalent: "z").keyEquivalentModifierMask = [
            .command, .shift,
        ]
        edit.addItem(.separator())
        edit.addItem(withTitle: String(localized: "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: String(localized: "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: String(localized: "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: String(localized: "Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let editItem = NSMenuItem(title: String(localized: "Edit"), action: nil, keyEquivalent: "")
        editItem.submenu = edit
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Tonton Claude", action: nil, keyEquivalent: ""))
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }
}
