import AppKit
import SwiftUI
import TontonCore

/// A session that runs on this Mac has its project folder right here: open it in the terminal, the editor or Finder.
/// Icon buttons in the chat header, plain items in the session list's context menu.
struct LocalFolderActions: View {
    enum Style { case icons, menu }

    let session: SessionSummary
    var style = Style.icons
    @EnvironmentObject var settings: AppSettings

    private var folderExists: Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: session.cwd, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    private var actions: [(label: String, icon: String, run: () -> Void)] {
        guard folderExists else { return [] }
        let terminal = settings.terminal.available, editor = settings.editor.available, folder = session.cwd
        return [
            ("Open in \(terminal.label)", "terminal", { terminal.open(folder) }),
            (
                editor == .defaultApp ? "Open the folder" : "Open in \(editor.label)", "chevron.left.forwardslash.chevron.right",
                { editor.open(folder) }
            ),
            ("Show in Finder", "folder", { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: folder) }),
        ]
    }

    var body: some View {
        ForEach(actions, id: \.label) { action in
            switch style {
            case .icons:
                Button(action: action.run) {
                    Image(systemName: action.icon).font(.notch(11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.secondary)
                .help(action.label)
                .accessibilityLabel(action.label)
            case .menu:
                Button(action.label, action: action.run)
            }
        }
    }
}
