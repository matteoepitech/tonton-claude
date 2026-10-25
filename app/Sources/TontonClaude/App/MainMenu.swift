import AppKit

/// The app never shows a menu bar, but text fields only get ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z through the key equivalents of an Edit menu.
enum MainMenu {
    @MainActor
    static func install() {
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z").keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Tonton Claude", action: nil, keyEquivalent: ""))
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }
}
