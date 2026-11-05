import SwiftUI
import TontonCore

// The hero screen's Upgrades page (#358): a card per stat with its rank as pips, the next rank's value and price, the
// arena, and the achievements with their progress. The numbers come from TontonCore (RPG.Upgrade, claimableMilestones).

/// Purchases preview the next rank's effect; cosmetic choices never enter the stat calculation.
struct RPGUpgradesView: View {
    @ObservedObject private var rpg = RPGStore.shared

    var body: some View {
        ScrollView {
            HeroUpgradesContent(
                hero: rpg.hero, enabled: rpg.ready && !rpg.busy, error: rpg.error, upgrade: { rpg.upgrade($0.rawValue) },
                arena: rpg.startArena, claim: rpg.claimAchievements
            )
            .padding(.vertical, 4)
        }
        .scrollIndicators(.never)
        .foregroundStyle(Theme.text)
    }
}

/// Pure presentation, also used by the image renderer: no account, store or network.
struct HeroUpgradesContent: View {
    let hero: RPG.State
    var enabled = true
    var error: String?
    var upgrade: (RPG.Stat) -> Void = { _ in }
    var arena: () -> Void = {}
    var claim: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Hero upgrades").font(.notch(13, weight: .bold)).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 6)
                PoolChip(text: String(localized: "\(hero.sparks) sparks"), systemImage: "sparkle")
            }
            if let error { Text(error).font(.notch(11)).foregroundStyle(Theme.warning).fixedSize(horizontal: false, vertical: true) }
            ForEach(RPG.Stat.allCases, id: \.self) { stat in statCard(RPG.Upgrade(stat, of: hero)) }
            arenaCard
            achievements.padding(.top, 6)
        }
    }

    private func statCard(_ stat: RPG.Upgrade) -> some View {
        let look = Self.look(stat.stat)
        return HStack(spacing: 10) {
            IconTile(systemName: look.symbol, tint: look.tint, size: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(look.label).font(.notch(12, weight: .bold))
                    Text("Rank \(stat.rank)/10").font(.notch(10)).foregroundStyle(Theme.tertiary).monospacedDigit()
                }
                HStack(spacing: 2) {
                    ForEach(0..<RPG.maxRank, id: \.self) { index in
                        Capsule().fill(index < stat.rank ? AnyShapeStyle(look.tint) : AnyShapeStyle(Theme.raised)).frame(
                            width: 9, height: 4)
                    }
                }
                .accessibilityHidden(true)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 5) {
                Group {
                    if let next = stat.next {
                        Text(verbatim: "\(stat.value) → \(next)")
                    } else {
                        Text(verbatim: "\(stat.value)")
                    }
                }
                .font(.notch(12, weight: .bold))
                .monospacedDigit()
                if let price = stat.price {
                    Button("Upgrade for \(price) sparks") { upgrade(stat.stat) }
                        .buttonStyle(NotchButtonStyle(kind: .primary))
                        .disabled(!enabled || !stat.affordable)
                        .help(stat.affordable ? Text("Spend \(price) sparks on the next rank") : Text("Not enough sparks yet"))
                } else {
                    PoolChip(text: String(localized: "Maximum rank"), systemImage: "crown.fill", tint: Theme.warning)
                }
            }
        }
        .poolCard(padding: 9)
        .accessibilityElement(children: .combine)
    }

    private var arenaCard: some View {
        HStack(spacing: 10) {
            IconTile(systemName: "gamecontroller.fill", tint: Theme.accent, size: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Tonton's arena").font(.notch(12, weight: .bold))
                Text("Move: arrows or WASD. Attack: Space. Pulse: E. Pause: Escape. Click the arena to focus it.")
                    .font(.notch(10)).foregroundStyle(Theme.tertiary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Button("Play arena", action: arena).buttonStyle(NotchButtonStyle(kind: .primary)).disabled(!enabled)
        }
        .poolCard(padding: 9)
    }

    private var achievements: some View {
        let claimable = hero.claimableMilestones
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Achievements").font(.notch(13, weight: .bold)).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 6)
                Button("Claim achievement boosters", action: claim)
                    .buttonStyle(NotchButtonStyle(kind: claimable.isEmpty ? .secondary : .primary))
                    .disabled(!enabled || claimable.isEmpty)
            }
            ForEach(RPG.milestones(hero), id: \.achievement) { milestone in
                milestoneCard(milestone, claimable: claimable.contains { $0.achievement == milestone.achievement })
            }
        }
    }

    private func milestoneCard(_ milestone: RPG.Milestone, claimable: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                IconTile(systemName: milestone.achievement.symbol, tint: milestone.reached ? Theme.warning : Theme.textDim, size: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(milestone.achievement.title).font(.notch(12, weight: .bold))
                    Text(milestone.achievement.detail).font(.notch(10)).foregroundStyle(Theme.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 6)
                if claimable {
                    PoolChip(text: String(localized: "Booster to claim"), systemImage: "shippingbox.fill")
                } else if milestone.reached {
                    PoolChip(text: String(localized: "Booster earned"), systemImage: "checkmark", tint: Theme.success)
                } else {
                    Text(verbatim: "\(min(milestone.done, milestone.target))/\(milestone.target)")
                        .font(.notch(10.5, weight: .semibold)).monospacedDigit().foregroundStyle(Theme.secondary)
                }
            }
            HeroMeter(
                value: Double(milestone.done), total: Double(milestone.target), tint: milestone.reached ? Theme.success : Theme.accent)
        }
        .poolCard(highlighted: claimable, padding: 9)
        .accessibilityElement(children: .combine)
    }

    static func look(_ stat: RPG.Stat) -> (label: String, symbol: String, tint: Color) {
        switch stat {
        case .health: (String(localized: "Health"), "heart.fill", Theme.danger)
        case .attack: (String(localized: "Attack"), "bolt.fill", Theme.warning)
        case .movement: (String(localized: "Movement"), "hare.fill", Theme.success)
        }
    }
}

/// A thin bar in the notch's colours: an achievement's progress, the arena's health.
struct HeroMeter: View {
    let value: Double
    let total: Double
    var tint = Theme.accent
    var height: CGFloat = 5

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.raised)
                Capsule().fill(tint).frame(
                    width: total > 0 ? max(value > 0 ? height : 0, geo.size.width * min(1, max(0, value) / total)) : 0)
            }
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityValue(Text("\(Int(min(value, total))) of \(Int(total))"))
    }
}
