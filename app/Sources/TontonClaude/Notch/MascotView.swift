import SwiftUI
import TontonCore

/// Tonton for a status, played frame by frame. He stays on his first frame with Reduce Motion.
struct MascotView: View {
    let status: SessionStatus
    var size: CGFloat = 18
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let frameDuration: TimeInterval = 0.45

    var body: some View {
        let pose = Mascot.pose(for: status)
        let frames = Mascot.frames(pose)
        TimelineView(.periodic(from: .now, by: Self.frameDuration)) { context in
            let tick = Int(context.date.timeIntervalSinceReferenceDate / Self.frameDuration)
            let frame = frames[reduceMotion ? 0 : tick % frames.count]
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
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Self.label(pose))
    }

    private static func label(_ pose: Mascot.Pose) -> String {
        switch pose {
        case .typing: "Claude is working"
        case .sleeping: "Nothing running"
        case .raisingHand: "A session needs you"
        }
    }

    private static func color(_ character: Character) -> Color? {
        switch character {
        case "#": Theme.accent
        case "o": .white
        case "-": .black.opacity(0.55)
        case "h": Color(hex: 0xA5A4FF)
        case "k": .white.opacity(0.35)
        case "z": .white.opacity(0.8)
        default: nil
        }
    }
}
