import SwiftUI
import TontonCore

/// Every cosmetic, a row per slot and a column per rarity, framed in its rarity's colour and weight. A first click puts
/// it on the big Tonton of the card to try it, a second one wears it, or takes it off.
struct HeroWardrobe: View {
    let hero: RPG.State
    @Binding var preview: RPG.Item?
    var enabled = true
    var equip: (RPG.Item?, RPG.Slot) -> Void = { _, _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Grid(alignment: .leading, horizontalSpacing: 6, verticalSpacing: 6) {
                ForEach(RPG.Slot.allCases, id: \.self) { slot in
                    GridRow {
                        Text(slot.label)
                            .font(.notch(11, weight: .medium))
                            .foregroundStyle(Theme.secondary)
                            .lineLimit(1)
                            .frame(minWidth: 58, alignment: .leading)
                        ForEach(RPG.catalog.filter { $0.slot == slot }) { item in tile(item) }
                    }
                }
            }
            Text("Click to try it on, click again to wear it.").font(.notch(11)).foregroundStyle(Theme.tertiary)
        }
    }

    private func tile(_ item: RPG.Item) -> some View {
        let owned = hero.owned.contains(item.id)
        let worn = hero.item(item.slot)?.id == item.id
        let trying = preview?.id == item.id
        let tier = CGFloat(RPG.Rarity.allCases.firstIndex(of: item.rarity) ?? 0)
        return Button {
            switch WardrobeTap(item, previewing: preview?.id, hero: hero) {
            case .preview: preview = item
            case .equip: if enabled { equip(item, item.slot) }
            case .unequip(let slot): if enabled { equip(nil, slot) }
            }
        } label: {
            HeroSprite(hero: Self.wearing(item, hero), pose: .resting, size: 40, animated: false)
                .opacity(owned ? 1 : 0.35)
                .frame(width: 50, height: 50)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color(hex: item.color).opacity(trying ? 0.22 : tier >= 3 ? 0.1 : 0.04)))
                .overlay {
                    RoundedRectangle(cornerRadius: 9)
                        .strokeBorder(Color(hex: item.color).opacity(owned || trying ? 1 : 0.4), lineWidth: trying ? 2.5 : 1 + tier * 0.4)
                }
                .overlay(alignment: .topTrailing) {
                    if worn {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.success, Theme.bg).offset(x: 4, y: -4)
                    } else if !owned {
                        Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(Theme.secondary).padding(4)
                    }
                }
                .contentShape(RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .help(Text("\(item.rarity.label) \(item.slot.label.lowercased())"))
        .accessibilityLabel(Text("\(item.rarity.label) \(item.slot.label.lowercased())"))
        .accessibilityValue(worn ? Text("Worn") : owned ? Text("Owned") : Text("Locked"))
        .accessibilityHint(trying && owned ? (worn ? Text("Takes it off") : Text("Wears it")) : Text("Tries it on Tonton"))
        .accessibilityAddTraits(trying ? .isSelected : [])
    }

    /// Tonton wearing one more item, owned or not: what the tiles and the card's preview show.
    static func wearing(_ item: RPG.Item?, _ hero: RPG.State) -> RPG.State {
        guard let item else { return hero }
        var state = hero
        if !state.owned.contains(item.id) { state.owned.append(item.id) }
        try? state.equip(item.id, in: item.slot)
        return state
    }
}
