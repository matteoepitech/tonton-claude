import AppKit
import Quartz
import SwiftUI
import TontonCore

/// Shows attachments full size in the Quick Look panel, above the notch: the files of the message being written and
/// the images of the conversation. Quick Look only reads files, so each one is written first to a folder only the user
/// can read, emptied at the next preview.
@MainActor
final class QuickLook: NSObject, QLPreviewPanelDataSource {
    static let shared = QuickLook()

    struct Item {
        let name: String
        let data: Data
    }

    private var urls: [URL] = []

    private static var folder: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("Tonton Claude Previews", isDirectory: true)
    }

    /// Opens `items` at `index`; the arrow keys move through the others. Returns why it couldn't, if it couldn't.
    @discardableResult
    func show(_ items: [Item], at index: Int) -> String? {
        guard !items.isEmpty else { return nil }
        let folder = Self.folder
        try? FileManager.default.removeItem(at: folder)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            return SaveFailure.message(folder, error)
        }
        var urls: [URL] = []
        for (offset, item) in items.enumerated() {
            // Each in a folder of its own: two attachments can share a name.
            let directory = folder.appendingPathComponent("\(offset)", isDirectory: true)
            let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: attributes)
            let url = directory.appendingPathComponent(PreviewFile.name(item.name))
            guard FileManager.default.createFile(atPath: url.path, contents: item.data, attributes: [.posixPermissions: 0o600]) else {
                return String(localized: "Could not prepare \(item.name) for Quick Look.")
            }
            urls.append(url)
        }
        self.urls = urls
        guard let panel = QLPreviewPanel.shared() else { return String(localized: "Quick Look is not available.") }
        panel.dataSource = self
        // The notch floats above regular windows: the panel has to float above the notch.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
        panel.reloadData()
        panel.currentPreviewItemIndex = min(max(index, 0), urls.count - 1)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        return nil
    }

    nonisolated func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        MainActor.assumeIsolated { urls.count }
    }

    nonisolated func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! {
        MainActor.assumeIsolated { urls.indices.contains(index) ? urls[index] as NSURL : nil }
    }
}

extension View {
    /// Click, or Space while the pointer rests on it and nothing is typed, to see it in Quick Look.
    func quickLook(_ open: @escaping () -> Void, state: NotchState) -> some View {
        onTapGesture(perform: open)
            .onHover { inside in state.quickLookUnderPointer = inside ? open : nil }
            .help("Quick Look (Space)")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { open() }
    }
}
