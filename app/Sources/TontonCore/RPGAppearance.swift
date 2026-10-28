import Foundation

/// Pixel-native cosmetic layers stay inside the 12×12 canvas and leave eyes, hands and status gestures readable.
extension RPG {
    public struct Pixel: Equatable, Sendable {
        public let x: Int
        public let y: Int
        public let color: UInt32
    }
    public static func pixels(hero: State, frame: Int) -> [Pixel] {
        var pixels: [Pixel] = []
        func add(_ slot: Slot, _ points: [(Int, Int)]) {
            guard let item = hero.item(slot) else { return }
            pixels += points.map { Pixel(x: $0.0, y: $0.1, color: item.color) }
        }
        if let hat = hero.item(.hat) {
            let tier = Rarity.allCases.firstIndex(of: hat.rarity) ?? 0
            add(.hat, (3...8).map { ($0, 1) } + (4...(5 + tier)).map { ($0, 0) })
        }
        add(.accessory, [(0, 5), (1, 4), (1, 5), (1, 6)])
        add(.aura, frame == 0 ? [(0, 1), (11, 3), (0, 9), (11, 10)] : [(0, 3), (11, 1), (0, 10), (11, 9)])
        add(.trail, frame == 0 ? [(2, 11), (4, 11), (6, 11)] : [(3, 11), (5, 11), (7, 11)])
        return pixels
    }
}
