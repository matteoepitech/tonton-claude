import SwiftUI
import TontonCore

/// Where the "+XP" flies: the rows of the session list and Tonton's ring in the bottom bar, in the open notch's space.
struct HeroAnchors: PreferenceKey {
    var rows: [String: Anchor<CGRect>] = [:]
    var ring: Anchor<CGRect>?

    static let defaultValue = HeroAnchors()

    static func reduce(value: inout HeroAnchors, nextValue: () -> HeroAnchors) {
        let next = nextValue()
        value.rows.merge(next.rows) { first, _ in first }
        value.ring = value.ring ?? next.ring
    }
}

/// "+18 XP" leaving the row of the session whose turn earned it and landing in Tonton's ring. Never shown with Reduce
/// Motion: the bottom bar then writes the XP beside the ring.
struct XPFloatView: View {
    static let duration: TimeInterval = 1.1
    let xp: Int
    let from: CGPoint
    let to: CGPoint
    @State private var landed = false
    @State private var faded = false

    var body: some View {
        Text("+\(xp) XP")
            .font(.system(size: Theme.textSize.points(12), weight: .heavy, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(Theme.success)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(Theme.bg.opacity(0.9)))
            .overlay(Capsule().strokeBorder(Theme.success.opacity(0.4)))
            .scaleEffect(landed ? 0.55 : 1)
            .opacity(faded ? 0 : 1)
            .position(landed ? to : from)
            .onAppear {
                withAnimation(.easeIn(duration: Self.duration)) { landed = true }
                withAnimation(.easeOut(duration: 0.2).delay(Self.duration * 0.8)) { faded = true }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// A new level, for a moment across the notch: Tonton cheering, the level, his title and the booster it earned, which
/// then waits on the ring until it is opened. Reduce Motion keeps him still and leaves out the burst.
struct LevelUpMoment: View {
    static let duration: TimeInterval = 3
    let level: Int
    let hero: RPG.State
    let width: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var burst = false

    var body: some View {
        HStack(spacing: 12) {
            // The burst starts behind him and flies out.
            HeroSprite(hero: hero, pose: .cheer, size: 48)
                .background {
                    if !reduceMotion {
                        ForEach(0..<14, id: \.self) { index in
                            let angle = Double(index) / 14 * 2 * .pi
                            Rectangle()
                                .fill(index.isMultiple(of: 2) ? Theme.accent : Color(hex: 0xFFE066))
                                .frame(width: 4, height: 4)
                                .offset(x: cos(angle) * (burst ? 64 : 12), y: sin(angle) * (burst ? 40 : 8))
                                .opacity(burst ? 0 : 1)
                        }
                    }
                }
            VStack(alignment: .leading, spacing: 2) {
                Text("Level \(level)!")
                    .font(.system(size: 18, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white)
                Text(RPG.title(level: level)).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.accent)
            }
            Spacer(minLength: 8)
            Label(
                hero.boosters.count > 1
                    ? String(localized: "\(hero.boosters.count) boosters are waiting") : String(localized: "A booster is waiting"),
                systemImage: "shippingbox.fill"
            )
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.white.opacity(0.75))
            .lineLimit(1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(width: width)
        .background(RoundedRectangle(cornerRadius: 20).fill(.black))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Theme.accent.opacity(0.6)))
        .environment(\.colorScheme, .dark)
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 0.9)) { burst = true }
        }
    }
}
