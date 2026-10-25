import Foundation

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
