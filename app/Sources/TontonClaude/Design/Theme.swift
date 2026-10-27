import AppKit
import SwiftUI
import TontonCore

/// One look for the open notch and the settings window (Settings › Notch › Look). The closed notch and the banner stay
/// black whatever the theme: they are part of the camera housing.
struct Palette: Hashable {
    /// Every color of the theme but the glass, from TontonCore, where their contrast is tested.
    var colors: ThemeColors
    /// The system's Increase Contrast: it strengthens hairlines (`Theme.line`) and the dim and faint text.
    var contrast = ContrastLevel.standard
    /// Behind code and typed values: fields, tokens and keys, a terminal's screen. Sunk in black on the dark themes.
    var code: Color = .black.opacity(0.35)
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
        case .midnight: Palette(colors: .midnight, scheme: .dark, material: .hudWindow, veil: .black)
        case .paper:
            Palette(colors: .paper, code: .black.opacity(0.05), scheme: .light, material: .popover, veil: Color(hex: ThemeColors.paper.bg))
        case .terminal: Palette(colors: .terminal, scheme: .dark, material: .hudWindow, veil: .black)
        case .synthwave: Palette(colors: .synthwave, scheme: .dark, material: .hudWindow, veil: Color(hex: ThemeColors.synthwave.bg))
        }
    }

    /// The theme as the system's Increase Contrast wants it.
    func palette(contrast: ContrastLevel) -> Palette {
        var palette = palette
        palette.contrast = contrast
        if contrast == .increased { palette.colors = palette.colors.increasedContrast }
        return palette
    }
}

/// The current palette's tokens. Views redraw on a theme change because the roots are keyed on it.
/// On the main actor, so the compiler checks that the palette is only read and written from the main thread.
@MainActor
enum Theme {
    /// Set from AppSettings when the theme or Increase Contrast changes; read by every view.
    static var palette = ThemeChoice.midnight.palette

    static var bg: Color { Color(hex: palette.colors.bg) }
    static var surface: Color { Color(hex: palette.colors.surface) }
    // Translucent so the frosted background keeps showing through controls.
    static var raised: Color { ink.opacity(0.06) }
    static var hover: Color { ink.opacity(0.09) }
    static var border: Color { line(0.07) }
    static var borderStrong: Color { line(0.12) }
    static var text: Color { Color(hex: palette.colors.text) }
    static var textDim: Color { Color(hex: palette.colors.textDim) }
    static var textFaint: Color { Color(hex: palette.colors.textFaint) }
    static var accent: Color { Color(hex: palette.colors.accent) }
    static var accentDeep: Color { Color(hex: palette.colors.accentDeep) }
    static var success: Color { Color(hex: palette.colors.success) }
    static var danger: Color { Color(hex: palette.colors.danger) }
    static var warning: Color { Color(hex: palette.colors.warning) }
    static var ink: Color { Color(hex: palette.colors.ink) }
    static var code: Color { palette.code }
    static var onAccent: Color { Color(hex: palette.colors.onAccent) }

    /// A hairline or a stroke in the ink, `opacity` strong, and stronger with Increase Contrast.
    static func line(_ opacity: Double) -> Color { ink.opacity(palette.contrast.line(opacity)) }

    // SwiftUI draws secondary and tertiary text as the text color made translucent, and Increase Contrast doesn't change
    // that. With it, they take the theme's dim and faint colors, which then reach 7:1 and 4.5:1.
    static var secondary: AnyShapeStyle { palette.contrast == .increased ? AnyShapeStyle(textDim) : AnyShapeStyle(.secondary) }
    static var tertiary: AnyShapeStyle { palette.contrast == .increased ? AnyShapeStyle(textFaint) : AnyShapeStyle(.tertiary) }

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
