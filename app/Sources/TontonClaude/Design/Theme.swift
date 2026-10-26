import AppKit
import SwiftUI

/// One look for the open notch and the settings window (Settings › Notch › Look). The closed notch and the banner stay
/// black whatever the theme: they are part of the camera housing.
struct Palette: Equatable {
    var bg: Color
    var surface: Color
    var text: Color
    var textDim: Color
    var textFaint: Color
    var accent: Color
    var accentDeep: Color
    var success: Color
    var danger: Color
    var warning: Color
    /// Text on an accent background, such as the user's messages.
    var onAccent: Color = .white
    /// The color of translucent fills and hairlines: white on dark themes, black on light ones.
    var ink: Color
    var scheme: ColorScheme
    /// The frosted glass behind the open notch.
    var material: NSVisualEffectView.Material
    /// What the veil over that glass is tinted with.
    var veil: Color
}

enum ThemeChoice: String, CaseIterable, Identifiable {
    case midnight, paper, terminal, synthwave
    var id: String { rawValue }

    var label: String {
        switch self {
        case .midnight: "Midnight"
        case .paper: "Paper"
        case .terminal: "Terminal"
        case .synthwave: "Synthwave"
        }
    }

    var palette: Palette {
        switch self {
        // Dark, sober: near-black surfaces, hairline borders, neutral grays and a single indigo accent.
        case .midnight:
            Palette(
                bg: Color(hex: 0x0A0A0B), surface: Color(hex: 0x111113), text: Color(hex: 0xF7F8F8), textDim: Color(hex: 0x8A8F98),
                textFaint: Color(hex: 0x5C6067), accent: Color(hex: 0x7170FF), accentDeep: Color(hex: 0x5E6AD2),
                success: Color(hex: 0x4CB782), danger: Color(hex: 0xEB5757), warning: Color(hex: 0xF2C94C), ink: .white, scheme: .dark,
                material: .hudWindow, veil: .black)
        // Warm paper and ink blue, in the light.
        case .paper:
            Palette(
                bg: Color(hex: 0xF7F4EC), surface: Color(hex: 0xFFFDF7), text: Color(hex: 0x1F1D1A), textDim: Color(hex: 0x6E685E),
                textFaint: Color(hex: 0x9E978B), accent: Color(hex: 0x2F5BD3), accentDeep: Color(hex: 0x2448B0),
                success: Color(hex: 0x2E8B57), danger: Color(hex: 0xC0392B), warning: Color(hex: 0xA86A12), ink: .black, scheme: .light,
                material: .popover, veil: Color(hex: 0xF7F4EC))
        // A phosphor screen: green on black.
        case .terminal:
            Palette(
                bg: Color(hex: 0x030603), surface: Color(hex: 0x081008), text: Color(hex: 0x4BFF7A), textDim: Color(hex: 0x2BBF55),
                textFaint: Color(hex: 0x1A7A36), accent: Color(hex: 0x4BFF7A), accentDeep: Color(hex: 0x23A548),
                success: Color(hex: 0x4BFF7A), danger: Color(hex: 0xFF5F56), warning: Color(hex: 0xE6E04A), onAccent: .black,
                ink: Color(hex: 0x4BFF7A), scheme: .dark, material: .hudWindow, veil: .black)
        // Neon on deep purple.
        case .synthwave:
            Palette(
                bg: Color(hex: 0x140A24), surface: Color(hex: 0x1C0F33), text: Color(hex: 0xFCE7FF), textDim: Color(hex: 0xB48CD9),
                textFaint: Color(hex: 0x7A5AA0), accent: Color(hex: 0xFF3EA5), accentDeep: Color(hex: 0xB23AFF),
                success: Color(hex: 0x2DE2E6), danger: Color(hex: 0xFF5370), warning: Color(hex: 0xFFD319), ink: .white, scheme: .dark,
                material: .hudWindow, veil: Color(hex: 0x140A24))
        }
    }
}

/// The current palette's tokens. Views redraw on a theme change because the roots are keyed on it.
/// On the main actor, so the compiler checks that the palette is only read and written from the main thread.
@MainActor
enum Theme {
    /// Set from AppSettings when the theme changes; read by every view.
    static var palette = ThemeChoice.midnight.palette

    static var bg: Color { palette.bg }
    static var surface: Color { palette.surface }
    // Translucent so the frosted background keeps showing through controls.
    static var raised: Color { palette.ink.opacity(0.06) }
    static var hover: Color { palette.ink.opacity(0.09) }
    static var border: Color { palette.ink.opacity(0.07) }
    static var borderStrong: Color { palette.ink.opacity(0.12) }
    static var text: Color { palette.text }
    static var textDim: Color { palette.textDim }
    static var textFaint: Color { palette.textFaint }
    static var accent: Color { palette.accent }
    static var accentDeep: Color { palette.accentDeep }
    static var success: Color { palette.success }
    static var danger: Color { palette.danger }
    static var warning: Color { palette.warning }
    static var ink: Color { palette.ink }
    static var onAccent: Color { palette.onAccent }

    static var accentGradient: LinearGradient { LinearGradient(colors: [accent, accentDeep], startPoint: .top, endPoint: .bottom) }
    static let mono = Font.system(size: 12, design: .monospaced)

    static func title(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font { .system(size: size, weight: weight) }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255,
            opacity: opacity)
    }
}
