import SwiftUI
import TontonCore

/// The status colors of the Mac app (SessionStatus+Color.swift), for the phone and its Live Activity.
extension SessionStatus {
    var tint: Color {
        switch self {
        case .working, .starting: .green
        case .waiting: .yellow
        case .permission: .orange
        case .idle: .blue
        case .error: .red
        case .ended, .offline: .gray
        }
    }

    var symbol: String {
        switch self {
        case .working, .starting: "bolt.fill"
        case .waiting: "ellipsis.bubble.fill"
        case .permission: "hand.raised.fill"
        case .idle: "checkmark"
        case .error: "exclamationmark.triangle.fill"
        case .ended, .offline: "moon.zzz.fill"
        }
    }
}

extension Color {
    /// The Mac app's Midnight accent.
    static let tonton = Color(red: 0x71 / 255, green: 0x70 / 255, blue: 0xFF / 255)
}

/// Tonton, the pixel character of the notch, standing still: widgets don't animate.
struct PixelMascot: View {
    let status: SessionStatus

    var body: some View {
        let frame = Mascot.frames(Mascot.pose(for: status))[0]
        Canvas { graphics, canvas in
            let pixel = canvas.width / CGFloat(Mascot.size)
            for (y, row) in frame.enumerated() {
                for (x, character) in row.enumerated() {
                    guard let color = Self.color(character) else { continue }
                    let square = CGRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel)
                    graphics.fill(Path(square), with: .color(color))
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }

    private static func color(_ character: Character) -> Color? {
        switch character {
        case "#": .tonton
        case "o": .white
        case "-": .black.opacity(0.55)
        case "h": Color(red: 0xA5 / 255, green: 0xA4 / 255, blue: 1)
        case "k": .white.opacity(0.35)
        case "z": .white.opacity(0.8)
        default: nil
        }
    }
}
