import SwiftUI
import TontonCore

/// Tonton in the bottom bar, in a hairline ring that fills with his level's XP. A click opens the hero screen in the right
/// column, another goes back to the conversation; a dot on the ring is a booster waiting to be opened. Permission alerts
/// keep priority: no celebration takes focus or opens a window.
struct RPGButton: View {
    @ObservedObject private var rpg = RPGStore.shared
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var state: NotchState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var celebrate: Bool {
        rpg.gain > 0 && settings.showMascot && settings.showAlerts && !settings.isQuiet(.other) && store.attentionCount == 0
    }

    var body: some View {
        let live = store.visibleSessions.filter(\.status.isLive).map(\.status)
        Button {
            state.showHero.toggle()
        } label: {
            HStack(spacing: 6) {
                LevelRing(progress: rpg.ready ? rpg.hero.progress : 0, lineWidth: 2) {
                    if settings.showMascot {
                        MascotView(status: SessionStatus.mostUrgent(live) ?? .idle, size: 18, hero: rpg.hero)
                    } else {
                        Text("\(rpg.hero.level)").font(.system(size: 10, weight: .bold, design: .rounded)).monospacedDigit()
                    }
                }
                .frame(width: 30, height: 30)
                .overlay(alignment: .topTrailing) {
                    if !rpg.hero.boosters.isEmpty {
                        Circle().fill(Theme.accent).frame(width: 7, height: 7).overlay(Circle().stroke(Theme.bg, lineWidth: 1.5))
                    }
                }
                .anchorPreference(key: HeroAnchors.self, value: .bounds) { HeroAnchors(ring: $0) }
                // The XP floats into the ring; without motion it is written beside it.
                if reduceMotion && celebrate {
                    Text("+\(rpg.gain) XP").font(.notch(11, weight: .semibold)).monospacedDigit().foregroundStyle(Theme.success)
                }
            }
            .background(RoundedRectangle(cornerRadius: 8).fill(state.showHero ? Theme.accent.opacity(0.14) : .clear).padding(-3))
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(Text(verbatim: "Tonton"))
        .accessibilityValue(rpg.ready ? Text("Level \(rpg.hero.level)") : Text(verbatim: ""))
        .accessibilityHint(state.showHero ? Text("Goes back to the conversation") : Text("Opens Tonton's hero screen"))
        .accessibilityAddTraits(state.showHero ? .isSelected : [])
    }

    private var help: String {
        guard rpg.ready else { return String(localized: "Tonton's hero screen") }
        if let left = rpg.hero.xpToNextLevel {
            return String(localized: "Tonton, level \(rpg.hero.level): \(left) XP to level \(rpg.hero.level + 1)")
        }
        return String(localized: "Tonton, level \(rpg.hero.level)")
    }
}
