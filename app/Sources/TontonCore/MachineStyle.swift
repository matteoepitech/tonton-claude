import Foundation

/// The icon and color the user picked for a machine in Settings › Machines, shown next to its sessions.
public struct MachineStyle: Codable, Equatable, Sendable {
    /// An SF Symbol name or an emoji.
    public var symbol: String?
    /// A place in the app's palette.
    public var color: Int?

    public init(symbol: String? = nil, color: Int? = nil) {
        self.symbol = symbol
        self.color = color
    }

    public var isEmpty: Bool { symbol == nil && color == nil }

    /// SF Symbol names are plain ASCII: anything else is an emoji.
    public var isEmoji: Bool { symbol.map { !$0.allSatisfy(\.isASCII) } ?? false }

    /// The symbols offered in the picker.
    public static let symbols = [
        "laptopcomputer", "desktopcomputer", "pc", "macmini", "server.rack", "cloud", "gamecontroller", "terminal", "cpu",
        "house", "building.2", "briefcase", "flask", "bolt", "leaf", "star",
    ]

    /// The emoji in what was typed, so a pasted sentence doesn't become an icon. Nil when there is none.
    public static func emoji(in text: String) -> String? {
        text.first { !$0.isASCII && !$0.isWhitespace }.map(String.init)
    }
}
