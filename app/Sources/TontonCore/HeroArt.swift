import Foundation

/// Tonton's 24×24 hero art: poses, the cosmetics drawn over them and their colours. The source is shared/rpg-art.json,
/// which the website reads too, so both draw the same pixels; `heroArtJSON` is a byte-identical copy of it, compared by
/// HeroArtTests. The 12×12 `Mascot` stays for the small sizes, where 24 pixels would not stay sharp.
public struct HeroArt: Decodable, Sendable {
    public enum Pose: String, CaseIterable, Sendable {
        /// Awake and empty-handed, breathing: the wardrobe's tiles and other small previews.
        case idle
        case working, resting, attention, cheer

        /// The same choice as `Mascot.pose(for:)`.
        public init(_ status: SessionStatus) {
            switch Mascot.pose(for: status) {
            case .typing: self = .working
            case .sleeping: self = .resting
            case .raisingHand: self = .attention
            }
        }
    }

    /// Where cosmetics hang on a frame: the top of the head, between the eyes, the middle and under the feet.
    public enum Anchor: String, Decodable, CaseIterable, Sendable {
        case head, eyes, center, feet
    }

    public struct Point: Decodable, Equatable, Sendable {
        public let x: Int
        public let y: Int

        public init(from decoder: Decoder) throws {
            var container = try decoder.unkeyedContainer()
            x = try container.decode(Int.self)
            y = try container.decode(Int.self)
        }
    }

    public struct Frame: Decodable, Sendable {
        public let rows: [String]
        public let anchors: [String: Point]
    }

    public struct Animation: Decodable, Sendable {
        /// How long each frame shows.
        public let ms: Int
        public let frames: [Frame]
    }

    /// A cosmetic's mask: its `origin` pixel lands on the frame's `anchor`.
    public struct Layer: Decodable, Sendable {
        public let anchor: Anchor
        public let origin: Point
        public let frames: [[String]]
    }

    public let version: Int
    public let size: Int
    /// One per ten levels, in English. The app shows `RPG.title(level:)`, its translation.
    public let titles: [String]
    /// Colours that never change: eyes, blush, the keyboard, the snore, the exclamation mark, sparkles.
    public let colors: [String: String]
    /// Outline `O` and three shades `1` `2` `3`, per rarity, and `base` for Tonton without a skin.
    public let ramps: [String: [String: String]]
    public let poses: [String: Animation]
    /// Per slot (hat, accessory, aura, trail), then per rarity.
    public let layers: [String: [String: Layer]]
    /// Back to front; `body` is the pose itself.
    public let order: [String]

    /// The art the app draws. Nil only if the copy no longer decodes, which HeroArtTests catches.
    public static let shared: HeroArt? = try? JSONDecoder().decode(HeroArt.self, from: Data(heroArtJSON.utf8))

    public func animation(_ pose: Pose) -> Animation? { poses[pose.rawValue] }

    /// Every lit pixel of Tonton wearing what `hero` has equipped, in `pose` at animation step `tick`: row by row, a later
    /// layer replacing what is under it. An unknown character, colour or anchor, or a pixel outside the square, is
    /// skipped rather than refused, so an older app draws a newer file.
    public func pixels(hero: RPG.State, pose: Pose, tick: Int) -> [RPG.Pixel] {
        guard size > 0, let animation = animation(pose), !animation.frames.isEmpty else { return [] }
        let frame = animation.frames[Self.index(tick, animation.frames.count)]
        var canvas = [UInt32?](repeating: nil, count: size * size)
        func put(_ x: Int, _ y: Int, _ character: Character, ramp: [String: String]?) {
            guard character != ".", (0..<size).contains(x), (0..<size).contains(y) else { return }
            let key = String(character)
            guard let color = (ramp?[key] ?? colors[key]).flatMap(Self.color) else { return }
            canvas[y * size + x] = color
        }
        for name in order {
            if name == "body" {
                let ramp = ramps[hero.item(.skin)?.rarity.rawValue ?? "base"] ?? ramps["base"]
                for (y, row) in frame.rows.enumerated() {
                    for (x, character) in row.enumerated() { put(x, y, character, ramp: ramp) }
                }
                continue
            }
            guard let slot = RPG.Slot(rawValue: name), let item = hero.item(slot), let layer = layers[name]?[item.rarity.rawValue],
                let anchor = frame.anchors[layer.anchor.rawValue], !layer.frames.isEmpty
            else { continue }
            let mask = layer.frames[Self.index(tick, layer.frames.count)]
            for (row, line) in mask.enumerated() {
                for (column, character) in line.enumerated() {
                    put(anchor.x + column - layer.origin.x, anchor.y + row - layer.origin.y, character, ramp: ramps[item.rarity.rawValue])
                }
            }
        }
        return canvas.indices.compactMap { index in
            canvas[index].map { RPG.Pixel(x: index % size, y: index / size, color: $0) }
        }
    }

    private static func index(_ tick: Int, _ count: Int) -> Int { ((tick % count) + count) % count }

    /// `#rrggbb`, the only form the file uses.
    static func color(_ text: String) -> UInt32? {
        guard text.count == 7, text.first == "#" else { return nil }
        return UInt32(text.dropFirst(), radix: 16)
    }
}

extension RPG {
    /// The title under the level: one per ten levels, the English of `titles` in shared/rpg-art.json.
    public static func title(level: Int) -> String {
        switch min(9, max(0, (level - 1) / 10)) {
        case 0: String(core: "Apprentice")
        case 1: String(core: "Builder")
        case 2: String(core: "Architect")
        case 3: String(core: "Pathfinder")
        case 4: String(core: "Inventor")
        case 5: String(core: "Artisan")
        case 6: String(core: "Sage")
        case 7: String(core: "Wizard")
        case 8: String(core: "Luminary")
        default: String(core: "Legend")
        }
    }
}
