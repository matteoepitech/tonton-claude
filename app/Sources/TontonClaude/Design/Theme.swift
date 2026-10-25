import SwiftUI

// Dark, sober palette: near-black surfaces, hairline borders, neutral grays and a single indigo accent.
enum Theme {
    static let bg = Color(hex: 0x0A0A0B)
    static let surface = Color(hex: 0x111113)
    // Translucent so the frosted background keeps showing through controls.
    static let raised = Color.white.opacity(0.06)
    static let hover = Color.white.opacity(0.09)
    static let border = Color.white.opacity(0.07)
    static let borderStrong = Color.white.opacity(0.12)
    static let text = Color(hex: 0xF7F8F8)
    static let textDim = Color(hex: 0x8A8F98)
    static let textFaint = Color(hex: 0x5C6067)
    static let accent = Color(hex: 0x7170FF)
    static let accentDeep = Color(hex: 0x5E6AD2)
    static let success = Color(hex: 0x4CB782)
    static let danger = Color(hex: 0xEB5757)
    static let warning = Color(hex: 0xF2C94C)

    static let accentGradient = LinearGradient(colors: [accent, accentDeep], startPoint: .top, endPoint: .bottom)
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
