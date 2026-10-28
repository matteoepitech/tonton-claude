import SwiftUI
import TontonCore

/// Tonton for a status, played frame by frame. He stays on his first frame with Reduce Motion.
struct MascotView: View {
    let status: SessionStatus
    var size: CGFloat = 18
    var hero = RPG.State()
    var animated = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let frameDuration: TimeInterval = 0.45

    var body: some View {
        let pose = Mascot.pose(for: status)
        let frames = Mascot.frames(pose)
        Group {
            if animated && !reduceMotion {
                TimelineView(.periodic(from: .now, by: Self.frameDuration)) { context in
                    let tick = Int(context.date.timeIntervalSinceReferenceDate / Self.frameDuration)
                    pixels(frame: frames[tick % frames.count], pose: pose, tick: tick)
                }
            } else {
                pixels(frame: frames[0], pose: pose, tick: 0)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Self.label(pose))
    }

    private func pixels(frame: [String], pose: Mascot.Pose, tick: Int) -> some View {
        let shift = Mascot.centering(pose)
        return Canvas { graphics, canvas in
            let pixel = canvas.width / CGFloat(Mascot.size)
            for (y, row) in frame.enumerated() {
                for (x, character) in row.enumerated() {
                    guard
                        let color = character == "#"
                            ? hero.item(.skin).map({ Color(hex: $0.color) }) ?? Self.color(character) : Self.color(character)
                    else { continue }
                    let square = CGRect(
                        x: CGFloat(x + shift.x) * pixel, y: CGFloat(y + shift.y) * pixel, width: pixel, height: pixel)
                    graphics.fill(Path(square), with: .color(color))
                }
            }
            for pixel in RPG.pixels(hero: hero, frame: tick % 2) {
                let square = CGRect(
                    x: CGFloat(pixel.x) * pixelSize(canvas), y: CGFloat(pixel.y) * pixelSize(canvas), width: pixelSize(canvas),
                    height: pixelSize(canvas))
                graphics.fill(Path(square), with: .color(Color(hex: pixel.color)))
            }
        }
    }

    private func pixelSize(_ size: CGSize) -> CGFloat { size.width / CGFloat(Mascot.size) }

    private static func label(_ pose: Mascot.Pose) -> String {
        switch pose {
        case .typing: String(localized: "Claude is working")
        case .sleeping: String(localized: "Nothing running")
        case .raisingHand: String(localized: "A session needs you")
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
