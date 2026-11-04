import SwiftUI
import TontonCore

/// Tonton large, in the 24×24 hero art, wearing what `hero` has equipped. Under 32 points the 12×12 mascot draws him
/// instead: 24 pixels in that space would no longer be whole points. Reduce Motion keeps him on his first frame.
struct HeroSprite: View {
    var hero: RPG.State
    var pose: HeroArt.Pose
    var size: CGFloat = 96
    var animated = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let art = HeroArt.shared, size >= 32 {
                let interval = Double(art.animation(pose)?.ms ?? 500) / 1000
                if animated && !reduceMotion {
                    TimelineView(.periodic(from: .now, by: interval)) { context in
                        canvas(art, tick: Int(context.date.timeIntervalSinceReferenceDate / interval))
                    }
                } else {
                    canvas(art, tick: 0)
                }
            } else {
                MascotView(status: Self.status(pose), size: size, hero: hero, animated: animated)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(Self.label(pose))
    }

    private func canvas(_ art: HeroArt, tick: Int) -> some View {
        let pixels = art.pixels(hero: hero, pose: pose, tick: tick)
        return Canvas { graphics, canvas in
            // Pixels on half points, whole screen pixels on a Retina display, so no row is drawn thicker than the others.
            let side = min(canvas.width, canvas.height)
            let pixel = max(1, (side / CGFloat(art.size) * 2).rounded(.down) / 2)
            let inset = (side - pixel * CGFloat(art.size)) / 2
            for point in pixels {
                let square = CGRect(x: inset + CGFloat(point.x) * pixel, y: inset + CGFloat(point.y) * pixel, width: pixel, height: pixel)
                graphics.fill(Path(square), with: .color(Color(hex: point.color)))
            }
        }
    }

    private static func status(_ pose: HeroArt.Pose) -> SessionStatus {
        switch pose {
        case .working: .working
        case .attention: .permission
        case .resting, .cheer: .idle
        }
    }

    static func label(_ pose: HeroArt.Pose) -> String {
        switch pose {
        case .working: String(localized: "Tonton is working")
        case .resting: String(localized: "Tonton is resting")
        case .attention: String(localized: "Tonton needs you")
        case .cheer: String(localized: "Tonton is cheering")
        }
    }
}
