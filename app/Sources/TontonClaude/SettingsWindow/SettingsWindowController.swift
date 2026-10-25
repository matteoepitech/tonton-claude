import AppKit
import SwiftUI

/// The frosted settings window, created on first use and kept around.
@MainActor
final class SettingsWindowController {
    private let store: SessionStore
    private let settings: AppSettings
    private var window: NSWindow?

    init(store: SessionStore, settings: AppSettings) {
        self.store = store
        self.settings = settings
    }

    func show(pane: SettingsPane? = nil) {
        if let pane { SettingsRouter.shared.pane = pane }
        let window = window ?? makeWindow()
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func close() {
        window?.close()
    }

    private func makeWindow() -> NSWindow {
        let host = NSHostingController(rootView: SettingsView().environmentObject(settings).environmentObject(store))
        host.sizingOptions = []
        let window = NSWindow(contentViewController: host)
        window.title = "Tonton Claude"
        window.styleMask = [.titled, .closable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
        window.setContentSize(NSSize(width: 920, height: 620))
        window.center()
        return window
    }
}
