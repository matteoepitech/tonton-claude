import SwiftUI
import TontonCore

/// A ring that fills with the XP of the current level, around Tonton: thick and cut in segments on the hero card, where
/// it reads as a gauge rather than a spinner, a hairline around the small mascot of the bottom bar and the closed notch.
struct LevelRing<Content: View>: View {
    let progress: Double
    var lineWidth: CGFloat = 2
    var segments = 0
    var tint: Color = Theme.accent
    var track: Color = Theme.line(0.14)
    @ViewBuilder var content: Content

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            let style = style(circumference: .pi * (side - lineWidth))
            ZStack {
                Circle().inset(by: lineWidth / 2).stroke(track, style: style)
                Circle()
                    .inset(by: lineWidth / 2)
                    .trim(from: 0, to: Self.clamped(progress))
                    .stroke(tint, style: style)
                    .rotationEffect(.degrees(-90))
                content.padding(lineWidth * 1.5)
            }
            .frame(width: side, height: side)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(1, contentMode: .fit)
    }

    private func style(circumference: CGFloat) -> StrokeStyle {
        guard segments > 0, circumference > 0 else { return StrokeStyle(lineWidth: lineWidth, lineCap: .round) }
        let step = circumference / CGFloat(segments)
        return StrokeStyle(lineWidth: lineWidth, lineCap: .butt, dash: [step * 0.72, step * 0.28])
    }

    /// A sliver shows from the first XP on; a full ring only at the last level.
    static func clamped(_ progress: Double) -> Double {
        progress <= 0 ? 0 : min(1, max(0.015, progress))
    }
}
