import XCTest

@testable import TontonCore

final class HeroArtTests: XCTestCase {
    private let art = HeroArt.shared

    /// The website reads shared/rpg-art.json; the app, its copy. The two must be the same bytes.
    func testTheCopyIsTheSharedFile() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../shared/rpg-art.json")
        let shared = try String(contentsOf: url, encoding: .utf8)
        XCTAssertEqual(heroArtJSON + "\n", shared, "paste shared/rpg-art.json into app/Sources/TontonCore/HeroArtData.swift")
    }

    func testEveryPoseIsWholeSquaresWithEveryAnchor() throws {
        let art = try XCTUnwrap(art)
        XCTAssertEqual(art.size, 24)
        for pose in HeroArt.Pose.allCases {
            let animation = try XCTUnwrap(art.animation(pose), pose.rawValue)
            XCTAssertGreaterThan(animation.frames.count, 1, "\(pose) should move")
            XCTAssertGreaterThan(animation.ms, 100)
            for frame in animation.frames {
                XCTAssertEqual(frame.rows.count, art.size)
                for row in frame.rows { XCTAssertEqual(row.count, art.size, row) }
                for anchor in HeroArt.Anchor.allCases {
                    let point = try XCTUnwrap(frame.anchors[anchor.rawValue], "\(pose) has no \(anchor)")
                    XCTAssert((0..<art.size).contains(point.x) && (0..<art.size).contains(point.y))
                }
            }
        }
    }

    /// Every cosmetic of the catalog has its art, and every character drawn has a colour.
    func testEveryCosmeticAndCharacterHasArt() throws {
        let art = try XCTUnwrap(art)
        let shades: Set<Character> = ["O", "1", "2", "3"]
        let fixed = Set(art.colors.keys.compactMap(\.first))
        for key in ["base"] + RPG.Rarity.allCases.map(\.rawValue) {
            let ramp = try XCTUnwrap(art.ramps[key], key)
            XCTAssertEqual(Set(ramp.keys.compactMap(\.first)), shades, key)
            XCTAssert(ramp.values.allSatisfy { HeroArt.color($0) != nil }, key)
        }
        XCTAssert(art.colors.values.allSatisfy { HeroArt.color($0) != nil })
        for frame in art.poses.values.flatMap(\.frames) {
            for row in frame.rows { XCTAssert(row.allSatisfy { $0 == "." || shades.contains($0) || fixed.contains($0) }, row) }
        }
        for slot in RPG.Slot.allCases where slot != .skin {
            for rarity in RPG.Rarity.allCases {
                let layer = try XCTUnwrap(art.layers[slot.rawValue]?[rarity.rawValue], "\(slot) \(rarity)")
                XCTAssertFalse(layer.frames.isEmpty)
                for row in layer.frames.joined() {
                    XCTAssert(row.allSatisfy { $0 == "." || shades.contains($0) || fixed.contains($0) }, row)
                }
            }
        }
        XCTAssertEqual(Set(art.order), ["aura", "body", "trail", "accessory", "hat"])
    }

    func testCosmeticsChangeThePixels() throws {
        let art = try XCTUnwrap(art)
        var hero = RPG.State()
        let plain = art.pixels(hero: hero, pose: .resting, tick: 0)
        XCTAssertGreaterThan(plain.count, 150)
        XCTAssert(plain.allSatisfy { (0..<24).contains($0.x) && (0..<24).contains($0.y) })
        // Peach without a skin; the skin's own green with one.
        XCTAssert(plain.contains { $0.color == 0xffb27a })
        hero.owned = ["skin-common", "hat-legendary"]
        try hero.equip("skin-common", in: .skin)
        XCTAssert(art.pixels(hero: hero, pose: .resting, tick: 0).contains { $0.color == 0x71c7a5 })
        XCTAssertFalse(art.pixels(hero: hero, pose: .resting, tick: 0).contains { $0.color == 0xffb27a })
        // A crown: gold where the head was empty, above the forehead.
        try hero.equip("hat-legendary", in: .hat)
        let crowned = art.pixels(hero: hero, pose: .attention, tick: 0)
        XCTAssert(crowned.contains { $0.y < 8 && $0.color == 0xffcf66 })
        // Something not owned is not drawn.
        hero.equipped["aura"] = "aura-legendary"
        XCTAssertEqual(art.pixels(hero: hero, pose: .attention, tick: 0), crowned)
    }

    func testTheHatFollowsTheBreath() throws {
        let art = try XCTUnwrap(art)
        var hero = RPG.State()
        hero.owned = ["hat-epic"]
        try hero.equip("hat-epic", in: .hat)
        let hatTop = { (tick: Int) in
            art.pixels(hero: hero, pose: .resting, tick: tick).filter { $0.color == 0x5a1d44 }.map(\.y).min()
        }
        XCTAssertEqual(try XCTUnwrap(hatTop(1)) - (try XCTUnwrap(hatTop(0))), 1)
    }

    func testThePoseFollowsTheSession() {
        XCTAssertEqual(HeroArt.Pose(.working), .working)
        XCTAssertEqual(HeroArt.Pose(.permission), .attention)
        XCTAssertEqual(HeroArt.Pose(.idle), .resting)
        XCTAssertEqual(HeroArt.Pose(.ended), .resting)
    }

    func testOneTitlePerTenLevels() throws {
        let art = try XCTUnwrap(art)
        XCTAssertEqual(art.titles.count, 10)
        XCTAssertEqual((1...100).map { RPG.title(level: $0) }.chunked(10).map { Set($0).count }, Array(repeating: 1, count: 10))
        XCTAssertEqual(stride(from: 1, through: 91, by: 10).map { RPG.title(level: $0) }, art.titles)
        XCTAssertEqual(RPG.title(level: 10), "Apprentice")
        XCTAssertEqual(RPG.title(level: 11), "Builder")
        XCTAssertEqual(RPG.title(level: 0), "Apprentice")
        XCTAssertEqual(RPG.title(level: 100), "Legend")
    }
}

extension Array {
    fileprivate func chunked(_ size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}
