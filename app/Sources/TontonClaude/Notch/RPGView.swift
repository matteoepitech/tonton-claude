import SwiftUI
import TontonCore

/// A compact entry point. Permission alerts keep priority; no celebration takes focus or opens a window.
struct RPGButton: View {
    @ObservedObject private var rpg = RPGStore.shared
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showing = false
    private var celebrate: Bool {
        rpg.gain > 0 && settings.showMascot && settings.showAlerts && !settings.isQuiet(.other) && store.attentionCount == 0
    }

    var body: some View {
        Button {
            showing.toggle()
        } label: {
            HStack(spacing: 5) {
                if settings.showMascot { MascotView(status: .idle, hero: rpg.hero) }
                if rpg.ready {
                    Text("Level \(rpg.hero.level)").monospacedDigit()
                    ProgressView(value: rpg.hero.progress).frame(width: 36)
                    if celebrate {
                        Text("+\(rpg.gain) XP").foregroundStyle(Theme.success)
                        if rpg.leveledUp { Image(systemName: "sparkles").accessibilityLabel("Level up!") }
                    }
                } else {
                    Text("Tonton")
                }
            }
            .font(.notch(11, weight: .semibold))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: rpg.hero.xp)
        }
        .buttonStyle(.plain)
        .help("Tonton's progression and wardrobe")
        .popover(isPresented: $showing) {
            RPGPanel(hero: rpg.hero, ready: rpg.ready, busy: rpg.busy, error: rpg.error, equip: rpg.equip)
                .frame(width: 460, height: 480)
        }
    }
}

/// Pure presentation also used by the image renderer, with no account or network access.
struct RPGPanel: View {
    let hero: RPG.State
    var ready = true
    var busy = false
    var error: String?
    var equip: (RPG.Item?, RPG.Slot) -> Void = { _, _ in }
    @State private var slot: RPG.Slot = .skin
    @State private var rarity: RPG.Rarity?
    @State private var ownedOnly = false
    @State private var preview: RPG.Item?
    @State private var pose: SessionStatus = .working

    private var previewHero: RPG.State {
        var state = hero
        if let preview {
            if !state.owned.contains(preview.id) { state.owned.append(preview.id) }
            try? state.equip(preview.id, in: preview.slot)
        }
        return state
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 16) {
                MascotView(status: pose, size: 64, hero: previewHero)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Tonton").font(.title2.bold())
                    Text("Level \(hero.level) · \(hero.xp) XP").monospacedDigit()
                    ProgressView(value: hero.progress)
                    Text("\(hero.sparks) sparks · \(hero.boosters.count) boosters").font(.caption).foregroundStyle(.secondary)
                }
            }
            Picker("Preview pose", selection: $pose) {
                Text("Working").tag(SessionStatus.working)
                Text("Resting").tag(SessionStatus.idle)
                Text("Needs attention").tag(SessionStatus.permission)
            }.pickerStyle(.segmented)
            if let error { Text(error).font(.caption).foregroundStyle(Theme.warning) }
            if !ready && error == nil { ProgressView("Syncing Tonton…") }
            Text("Wardrobe").font(.headline)
            Picker("Cosmetic slot", selection: $slot) {
                ForEach(RPG.Slot.allCases, id: \.self) { Text($0.label).tag($0) }
            }.pickerStyle(.segmented)
            HStack {
                Picker("Rarity", selection: $rarity) {
                    Text("All rarities").tag(nil as RPG.Rarity?)
                    ForEach(RPG.Rarity.allCases, id: \.self) { Text($0.label).tag(Optional($0)) }
                }
                Toggle("Owned only", isOn: $ownedOnly)
                Button("Unequip") { equip(nil, slot) }.disabled(!ready || busy || hero.item(slot) == nil)
            }.font(.caption)
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(
                        RPG.catalog.filter {
                            $0.slot == slot && (rarity == nil || $0.rarity == rarity) && (!ownedOnly || hero.owned.contains($0.id))
                        }
                    ) { item in
                        itemRow(item)
                    }
                }
            }
            Text("Levels 2–6 unlock starter cosmetics. Boosters are saved; opening and combat are coming later.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(18)
        .background(Theme.bg)
        .foregroundStyle(Theme.text)
        .onChange(of: slot) { _, _ in preview = nil }
    }

    private func itemRow(_ item: RPG.Item) -> some View {
        let owned = hero.owned.contains(item.id)
        let equipped = hero.equipped[item.slot.rawValue] == item.id
        return HStack {
            Image(systemName: owned ? "sparkles" : "lock.fill").foregroundStyle(Color(hex: item.color))
            Text(item.rarity.label).fontWeight(.medium)
            Text(item.slot.label).foregroundStyle(.secondary)
            Spacer()
            Button("Preview") { preview = item }
            Button(equipped ? "Equipped" : owned ? "Equip" : "Locked") { equip(item, item.slot) }
                .disabled(!ready || busy || !owned || equipped)
        }
        .font(.caption)
        .padding(9)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.raised))
    }
}
