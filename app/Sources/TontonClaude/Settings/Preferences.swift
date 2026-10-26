import AppKit

enum HotKeyPreset: String, CaseIterable, Identifiable {
    case optionCommandN, controlOptionSpace, optionCommandT, controlOptionCommandC, off
    var id: String { rawValue }

    var label: String {
        switch self {
        case .optionCommandN: "⌥⌘N"
        case .controlOptionSpace: "⌃⌥Space"
        case .optionCommandT: "⌥⌘T"
        case .controlOptionCommandC: "⌃⌥⌘C"
        case .off: "Off"
        }
    }

    var keys: [String] {
        switch self {
        case .optionCommandN: ["⌥", "⌘", "N"]
        case .controlOptionSpace: ["⌃", "⌥", "Space"]
        case .optionCommandT: ["⌥", "⌘", "T"]
        case .controlOptionCommandC: ["⌃", "⌥", "⌘", "C"]
        case .off: []
        }
    }
}

enum DisplayChoice: String, CaseIterable, Identifiable {
    case builtIn, main
    var id: String { rawValue }
    var label: String { self == .builtIn ? "Built-in display" : "Main display" }
}

enum NotchSizeChoice: String, CaseIterable, Identifiable {
    case compact, standard, large
    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    var size: CGSize {
        switch self {
        case .compact: CGSize(width: 640, height: 460)
        case .standard: CGSize(width: 760, height: 540)
        case .large: CGSize(width: 900, height: 640)
        }
    }
}

/// The app that opens files from tool calls. Editors that are not installed are left out of the menu.
enum EditorChoice: String, CaseIterable, Identifiable {
    case vscode, cursor, zed, xcode, sublime, defaultApp
    var id: String { rawValue }

    var label: String {
        switch self {
        case .vscode: "VS Code"
        case .cursor: "Cursor"
        case .zed: "Zed"
        case .xcode: "Xcode"
        case .sublime: "Sublime Text"
        case .defaultApp: "Default app"
        }
    }

    private var bundleIdentifier: String? {
        switch self {
        case .vscode: "com.microsoft.VSCode"
        case .cursor: "com.todesktop.230313mzl4w4u92"
        case .zed: "dev.zed.Zed"
        case .xcode: "com.apple.dt.Xcode"
        case .sublime: "com.sublimetext.4"
        case .defaultApp: nil
        }
    }

    private var appURL: URL? { bundleIdentifier.flatMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) } }

    static var installed: [EditorChoice] { allCases.filter { $0 == .defaultApp || $0.appURL != nil } }

    /// This editor, or the default app once it has been uninstalled.
    var available: EditorChoice { self == .defaultApp || appURL != nil ? self : .defaultApp }

    /// Opens a file, or a folder as a project.
    func open(_ path: String) {
        let file = URL(fileURLWithPath: path)
        if let appURL {
            NSWorkspace.shared.open([file], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(file)
        }
    }
}

/// The terminal that opens the folder of a session running on this Mac. Terminals that are not installed are left out.
enum TerminalChoice: String, CaseIterable, Identifiable {
    case terminal, iterm, ghostty, warp
    var id: String { rawValue }

    var label: String {
        switch self {
        case .terminal: "Terminal"
        case .iterm: "iTerm"
        case .ghostty: "Ghostty"
        case .warp: "Warp"
        }
    }

    private var bundleIdentifier: String {
        switch self {
        case .terminal: "com.apple.Terminal"
        case .iterm: "com.googlecode.iterm2"
        case .ghostty: "com.mitchellh.ghostty"
        case .warp: "dev.warp.Warp-Stable"
        }
    }

    private var appURL: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) }

    static var installed: [TerminalChoice] { allCases.filter { $0 == .terminal || $0.appURL != nil } }

    /// This terminal, or Terminal once it has been uninstalled.
    var available: TerminalChoice { appURL != nil ? self : .terminal }

    /// A new window in the folder.
    func open(_ folder: String) {
        guard let appURL = available.appURL else { return }
        NSWorkspace.shared.open(
            [URL(fileURLWithPath: folder, isDirectory: true)], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration())
    }
}
