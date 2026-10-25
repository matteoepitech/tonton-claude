import AppKit

extension NSSavePanel {
    /// The notch floats above regular windows, so file dialogs have to float above the notch.
    func runAboveNotch() -> NSApplication.ModalResponse {
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
        NSApp.activate(ignoringOtherApps: true)
        return runModal()
    }
}
