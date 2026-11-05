import SwiftUI
import TontonCore

/// Purchases preview the next rank's effect; cosmetic choices never enter the stat calculation.
struct RPGUpgradesView: View {
    @ObservedObject private var rpg = RPGStore.shared
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                // Tonton himself is on the card above.
                HStack(alignment: .firstTextBaseline) {
                    Text("Hero upgrades").font(.notch(15, weight: .semibold))
                    Spacer()
                    Text("\(rpg.hero.sparks) sparks").monospacedDigit().foregroundStyle(Theme.secondary)
                }
                if let error = rpg.error { Text(error).foregroundStyle(Theme.warning) }
                ForEach(["health", "attack", "movement"], id: \.self) { stat in
                    upgradeRow(stat)
                }
                Button("Play arena") { rpg.startArena() }.disabled(!rpg.ready)
                Text("Move: arrows or WASD. Attack: Space. Pulse: E. Pause: Escape. Click the arena to focus it.")
                    .font(.caption).foregroundStyle(.secondary)
                Text("Achievements").font(.headline)
                ForEach(RPG.milestones(rpg.hero), id: \.achievement) { milestone in
                    VStack(alignment: .leading) {
                        Label(milestone.achievement.title, systemImage: milestone.achievement.symbol)
                        Text(milestone.achievement.detail).font(.caption)
                        ProgressView(value: Double(min(milestone.done, milestone.target)), total: Double(milestone.target))
                    }
                }
                Button("Claim achievement boosters") { rpg.claimAchievements() }.disabled(!rpg.ready || rpg.busy)
            }.padding(.vertical, 4)
        }.foregroundStyle(Theme.text)
    }
    private func upgradeRow(_ stat: String) -> some View {
        let rank = rpg.hero.upgrades[stat] ?? 0
        let stats = RPG.Stats(hero: rpg.hero)
        let value = stat == "health" ? stats.health : stat == "attack" ? stats.attack : stats.movement
        let step = stat == "health" ? 15 : stat == "attack" ? 3 : 6
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                if stat == "health" { Text("Health") } else if stat == "attack" { Text("Attack") } else { Text("Movement") }
                Spacer()
                Text("Rank \(rank)/10")
            }
            if rank < 10 {
                Text("\(Int(value)) → \(Int(value) + step)").monospacedDigit()
                Button("Upgrade for \((rank + 1) * 10) sparks") { rpg.upgrade(stat) }
                    .disabled(!rpg.ready || rpg.busy || rpg.hero.sparks < (rank + 1) * 10)
            } else {
                Text("Maximum rank")
            }
        }.padding(12).background(RoundedRectangle(cornerRadius: 8).fill(Theme.raised))
    }
}
