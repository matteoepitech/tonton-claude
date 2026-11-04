import Foundation

extension RPG.State {
    /// XP still to earn before the next level, the "230 XP to level 8" under the ring. Nil at the last level.
    public var xpToNextLevel: Int? {
        level >= 100 ? nil : max(0, RPG.threshold(level + 1) - xp)
    }
}

/// What a click on a wardrobe tile does: the first shows the item on the big Tonton, the second puts it on, or takes it
/// off when he already wears it. An item not owned yet can be looked at, never worn.
public enum WardrobeTap: Equatable, Sendable {
    case preview(String)
    case equip(String)
    case unequip(RPG.Slot)

    public init(_ item: RPG.Item, previewing: String?, hero: RPG.State) {
        guard previewing == item.id, hero.owned.contains(item.id) else {
            self = .preview(item.id)
            return
        }
        self = hero.item(item.slot)?.id == item.id ? .unequip(item.slot) : .equip(item.id)
    }
}
