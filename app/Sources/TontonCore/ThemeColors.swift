import Foundation

/// The colors of each theme (Settings › Notch › Look), as 0xRRGGBB, and what the system's Increase Contrast does to them.
/// The app turns them into SwiftUI colors in Design/Theme.swift.
public struct ThemeColors: Hashable, Sendable {
    public var bg: UInt32
    public var surface: UInt32
    public var text: UInt32
    public var textDim: UInt32
    public var textFaint: UInt32
    public var accent: UInt32
    public var accentDeep: UInt32
    public var success: UInt32
    public var danger: UInt32
    public var warning: UInt32
    /// Text on an accent background, such as the user's messages.
    public var onAccent: UInt32
    /// The color of translucent fills and hairlines: white on dark themes, black on light ones.
    public var ink: UInt32

    /// Dark, sober: near-black surfaces, hairline borders, neutral grays and a single indigo accent.
    public static let midnight = ThemeColors(
        bg: 0x0A0A0B, surface: 0x111113, text: 0xF7F8F8, textDim: 0x8A8F98, textFaint: 0x5C6067, accent: 0x7170FF,
        accentDeep: 0x5E6AD2, success: 0x4CB782, danger: 0xEB5757, warning: 0xF2C94C, onAccent: 0xFFFFFF, ink: 0xFFFFFF)
    /// Warm paper and ink blue, in the light.
    public static let paper = ThemeColors(
        bg: 0xF7F4EC, surface: 0xFFFDF7, text: 0x1F1D1A, textDim: 0x6E685E, textFaint: 0x9E978B, accent: 0x2F5BD3,
        accentDeep: 0x2448B0, success: 0x2E8B57, danger: 0xC0392B, warning: 0xA86A12, onAccent: 0xFFFFFF, ink: 0x000000)
    /// A phosphor screen: green on black.
    public static let terminal = ThemeColors(
        bg: 0x030603, surface: 0x081008, text: 0x4BFF7A, textDim: 0x2BBF55, textFaint: 0x1A7A36, accent: 0x4BFF7A,
        accentDeep: 0x23A548, success: 0x4BFF7A, danger: 0xFF5F56, warning: 0xE6E04A, onAccent: 0x000000, ink: 0x4BFF7A)
    /// Neon on deep purple.
    public static let synthwave = ThemeColors(
        bg: 0x140A24, surface: 0x1C0F33, text: 0xFCE7FF, textDim: 0xB48CD9, textFaint: 0x7A5AA0, accent: 0xFF3EA5,
        accentDeep: 0xB23AFF, success: 0x2DE2E6, danger: 0xFF5370, warning: 0xFFD319, onAccent: 0xFFFFFF, ink: 0xFFFFFF)

    /// With Increase Contrast: dim text reaches 7:1 on the theme's backgrounds and faint text 4.5:1 (WCAG AAA and AA),
    /// each pulled toward the text color only as far as it needs, so the theme keeps its tint.
    public var increasedContrast: ThemeColors {
        var colors = self
        colors.textDim = Contrast.raise(textDim, toward: text, on: [bg, surface], to: 7)
        colors.textFaint = Contrast.raise(textFaint, toward: text, on: [bg, surface], to: 4.5)
        return colors
    }
}

/// Whether the system's Increase Contrast is on (System Settings › Accessibility › Display).
public enum ContrastLevel: Hashable, Sendable {
    case standard, increased

    /// The opacity of a hairline drawn at `opacity`. Increase Contrast lays it three times over, so the faintest lines
    /// gain the most and none goes past opaque.
    public func line(_ opacity: Double) -> Double {
        switch self {
        case .standard: opacity
        case .increased: 1 - pow(1 - min(max(opacity, 0), 1), 3)
        }
    }
}

/// WCAG 2 contrast between colors written 0xRRGGBB, in sRGB.
public enum Contrast {
    /// From 0 for black to 1 for white.
    public static func luminance(_ color: UInt32) -> Double {
        func linear(_ shift: UInt32) -> Double {
            let value = Double((color >> shift) & 0xFF) / 255
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(16) + 0.7152 * linear(8) + 0.0722 * linear(0)
    }

    /// From 1, the same color, to 21, black on white. Text needs 4.5 to pass WCAG AA and 7 to pass AAA.
    public static func ratio(_ a: UInt32, _ b: UInt32) -> Double {
        let (la, lb) = (luminance(a), luminance(b))
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /// `from` moved `amount` of the way to `to`, channel by channel; `amount` is clamped to 0...1.
    public static func mix(_ from: UInt32, _ to: UInt32, _ amount: Double) -> UInt32 {
        let t = min(max(amount, 0), 1)
        return [16, 8, 0].reduce(UInt32(0)) { result, shift in
            let (a, b) = (Double((from >> shift) & 0xFF), Double((to >> shift) & 0xFF))
            return result | UInt32((a + (b - a) * t).rounded()) << shift
        }
    }

    /// `color` moved toward `strong` in steps of 1 %, just far enough to reach `minimum` on every background; `strong`
    /// itself when no step does.
    public static func raise(_ color: UInt32, toward strong: UInt32, on backgrounds: [UInt32], to minimum: Double) -> UInt32 {
        let steps = (0...100).lazy.map { mix(color, strong, Double($0) / 100) }
        return steps.first { candidate in backgrounds.allSatisfy { ratio(candidate, $0) >= minimum } } ?? strong
    }
}
