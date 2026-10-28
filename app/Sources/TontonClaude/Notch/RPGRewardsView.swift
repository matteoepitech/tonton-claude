import SwiftUI
import TontonCore

/// Openings show a committed receipt, so closing, skipping or reconnecting never changes the drop.
struct RPGRewardsView: View {
    @ObservedObject private var rpg = RPGStore.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var revealed = false
    @State private var burst = false
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                Text("Boosters").font(.title2.bold())
                Text("One cosmetic per booster. Common 60%, uncommon 25%, rare 10%, epic 4%, legendary 1%.")
                    .font(.caption).foregroundStyle(.secondary)
                if let error = rpg.error { Text(error).foregroundStyle(Theme.warning) }
                if let id = rpg.opening, let receipt = rpg.hero.openings[id],
                    let item = RPG.catalog.first(where: { $0.id == receipt.item })
                {
                    reveal(item, receipt: receipt)
                        .id(id)
                        .task(id: id) {
                            revealed = reduceMotion
                            burst = false
                            if !reduceMotion { try? await Task.sleep(for: .seconds(1.2)) }
                            guard !Task.isCancelled, !revealed else { return }
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.4)) {
                                revealed = true; burst = true
                            }
                            try? await Task.sleep(for: .seconds(0.8))
                            guard !Task.isCancelled else { return }
                            withAnimation(.easeOut(duration: 0.4)) { burst = false }
                        }
                }
                if rpg.hero.boosters.isEmpty { Text("No unopened boosters. Earn levels, beat a boss or complete a team goal.") }
                ForEach(rpg.hero.boosters, id: \.self) { id in
                    HStack {
                        Image(systemName: "shippingbox.fill").foregroundStyle(Theme.accent)
                        Text("Earned booster")
                        Spacer()
                        Button("Open") { rpg.openBooster(id) }.disabled(!rpg.ready || rpg.busy)
                    }
                }
                if !rpg.hero.openings.isEmpty {
                    Text("Previous openings").font(.headline)
                    ForEach(rpg.hero.openings.keys.sorted(), id: \.self) { id in
                        if let receipt = rpg.hero.openings[id], let item = RPG.catalog.first(where: { $0.id == receipt.item }) {
                            Button {
                                rpg.showOpening(id)
                            } label: {
                                HStack {
                                    MascotView(status: .idle, size: 32, hero: wearing(item))
                                    Text(item.rarity.label)
                                    Text(item.slot.label)
                                    Spacer()
                                    if receipt.duplicateSparks > 0 { Text("+\(receipt.duplicateSparks) sparks") }
                                }
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }.padding(18)
        }.background(Theme.bg).foregroundStyle(Theme.text)
    }
    private func wearing(_ item: RPG.Item) -> RPG.State {
        var hero = rpg.hero
        try? hero.equip(item.id, in: item.slot)
        return hero
    }
    private func reveal(_ item: RPG.Item, receipt: RPG.Opening) -> some View {
        VStack(spacing: 12) {
            if revealed {
                MascotView(status: .working, size: 96, hero: wearing(item))
                    .overlay {
                        if !reduceMotion {
                            ForEach(0..<(5 + (RPG.Rarity.allCases.firstIndex(of: item.rarity) ?? 0) * 3), id: \.self) { index in
                                Rectangle().fill(Color(hex: item.color)).frame(width: 4, height: 4)
                                    .offset(
                                        x: cos(Double(index) * 2.4) * (burst ? 85 : 30), y: sin(Double(index) * 2.4) * (burst ? 70 : 25)
                                    )
                                    .opacity(burst ? 1 : 0)
                            }
                        }
                    }
                    .transition(.scale.combined(with: .opacity))
                HStack {
                    Text(item.rarity.label).bold(); Text(item.slot.label)
                }
                if receipt.duplicateSparks > 0 { Text("Duplicate converted to \(receipt.duplicateSparks) sparks.") }
                Button("Equip") { rpg.equip(item, slot: item.slot) }.disabled(rpg.busy)
            } else {
                Image(systemName: "shippingbox.fill").font(.system(size: 64))
                Text("Revealing your cosmetic…")
                Button("Skip animation") { revealed = true }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 200)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(hex: item.color).opacity(revealed ? 0.2 : 0.05)))
        .overlay {
            RoundedRectangle(cornerRadius: 16).strokeBorder(
                Color(hex: item.color), lineWidth: CGFloat(1 + (RPG.Rarity.allCases.firstIndex(of: item.rarity) ?? 0)))
        }
        .accessibilityElement(children: .contain)
    }
}

/// Purchases preview the next rank's effect; cosmetic choices never enter the stat calculation.
struct RPGUpgradesView: View {
    @ObservedObject private var rpg = RPGStore.shared
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                HStack {
                    MascotView(status: .working, size: 64, hero: rpg.hero)
                    VStack(alignment: .leading) {
                        Text("Hero upgrades").font(.title2.bold()); Text("\(rpg.hero.sparks) sparks")
                    }
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
            }.padding(18)
        }.background(Theme.bg).foregroundStyle(Theme.text)
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
