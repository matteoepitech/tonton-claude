import SwiftUI
import TontonCore

/// What the card says about today: XP earned, the streak of days, XP per local hour.
struct HeroDay: Equatable {
    var xp = 0
    var streak = 0
    /// 24 values, index 0 is midnight here.
    var hours = [Int](repeating: 0, count: 24)
    /// Whether today already counts in the streak; until then the streak ends yesterday.
    var counted = false
}

/// Tonton large in his level ring, the level, his title, what is left to the next level and today.
struct HeroCard: View {
    enum Layout { case centered, row }
    var layout: Layout = .row
    /// What he wears: the hero, or the hero trying on the wardrobe's preview.
    let hero: RPG.State
    let pose: HeroArt.Pose
    var day = HeroDay()
    /// The current hour, highlighted in the bars; nil in the renderer's fixed images.
    var hour: Int?

    var body: some View {
        switch layout {
        case .row:
            HStack(alignment: .center, spacing: 16) {
                ring(side: 112, sprite: 72)
                VStack(alignment: .leading, spacing: 6) {
                    names
                    toNext
                    todayLine
                    HourBars(hours: day.hours, current: hour).frame(height: 22)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .centered:
            VStack(spacing: 8) {
                ring(side: 148, sprite: 96)
                names
                toNext
                todayLine
                HourBars(hours: day.hours, current: hour).frame(width: 220, height: 24)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func ring(side: CGFloat, sprite: CGFloat) -> some View {
        LevelRing(progress: hero.progress, lineWidth: 7, segments: 36) {
            HeroSprite(hero: hero, pose: pose, size: sprite)
        }
        .frame(width: side, height: side)
        .overlay(alignment: .bottom) { badge.offset(y: 6) }
        .accessibilityElement(children: .combine)
        .accessibilityValue(Text("Level \(hero.level)"))
    }

    private var badge: some View {
        Text("\(hero.level)")
            .font(.system(size: Theme.textSize.points(12), weight: .heavy, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(Theme.onAccent)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(Theme.accent))
            .overlay(Capsule().strokeBorder(Theme.bg, lineWidth: 2))
            .accessibilityHidden(true)
    }

    private var names: some View {
        HStack(spacing: 6) {
            Text(verbatim: "Tonton").font(.notch(16, weight: .bold))
            Text(RPG.title(level: hero.level))
                .font(.notch(11, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill(Theme.accent.opacity(0.14)))
        }
    }

    @ViewBuilder private var toNext: some View {
        Group {
            if let left = hero.xpToNextLevel {
                Text("\(left) XP to level \(hero.level + 1)")
            } else {
                Text("Highest level")
            }
        }
        .font(.notch(11))
        .monospacedDigit()
        .foregroundStyle(Theme.secondary)
    }

    /// On one line when it fits, the streak under today's XP otherwise.
    private var todayLine: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                todayXP
                streak
            }
            VStack(alignment: layout == .centered ? .center : .leading, spacing: 4) {
                todayXP
                streak
            }
        }
        .font(.notch(11, weight: .medium))
        .labelStyle(.titleAndIcon)
    }

    private var todayXP: some View {
        Label {
            Text("+\(day.xp) XP today").monospacedDigit()
        } icon: {
            Image(systemName: "bolt.fill").foregroundStyle(Theme.warning)
        }
        .fixedSize()
    }

    private var streak: some View {
        HStack(spacing: 8) {
            Label {
                Text("\(day.streak) days in a row").monospacedDigit()
            } icon: {
                Image(systemName: "flame.fill").foregroundStyle(day.streak > 0 ? Color.orange : Theme.textFaint)
            }
            StreakDays(streak: day.streak, counted: day.counted)
        }
        .fixedSize()
    }
}

/// The last seven days, today on the right, lit for the days of the streak.
struct StreakDays: View {
    let streak: Int
    let counted: Bool

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<7, id: \.self) { index in
                let daysAgo = 6 - index
                let lit = (counted ? daysAgo < streak : daysAgo >= 1 && daysAgo <= streak)
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(lit ? Color.orange : Theme.line(daysAgo == 0 ? 0.3 : 0.14))
                    .frame(width: 6, height: 6)
            }
        }
        .accessibilityHidden(true)
    }
}

/// XP per hour today: one bar an hour, the current one in the accent.
struct HourBars: View {
    let hours: [Int]
    var current: Int?

    var body: some View {
        let top = max(1, hours.max() ?? 0)
        GeometryReader { proxy in
            let step = proxy.size.width / 24
            HStack(alignment: .bottom, spacing: 0) {
                ForEach(0..<24, id: \.self) { hour in
                    let value = hour < hours.count ? hours[hour] : 0
                    RoundedRectangle(cornerRadius: 1)
                        .fill(hour == current ? Theme.accent : value > 0 ? Theme.accent.opacity(0.55) : Theme.line(0.12))
                        .frame(width: max(1, step - 2), height: value > 0 ? max(3, proxy.size.height * CGFloat(value) / CGFloat(top)) : 2)
                        .frame(width: step, height: proxy.size.height, alignment: .bottom)
                }
            }
        }
        .accessibilityElement()
        .accessibilityLabel("XP per hour today")
        .accessibilityValue(Text(Self.spoken(hours)))
    }

    /// The busiest hour, said rather than drawn.
    static func spoken(_ hours: [Int]) -> String {
        guard let top = hours.max(), top > 0, let hour = hours.firstIndex(of: top) else { return String(localized: "No XP yet") }
        return String(localized: "Most at \(hour):00, \(top) XP")
    }
}
