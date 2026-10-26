import XCTest

@testable import TontonCore

final class GlassVeilTests: XCTestCase {
    func testTheMiddleIsTheOriginalLook() {
        XCTAssertEqual(GlassVeil(transparency: 0.5), GlassVeil.original)
    }

    func testFromOpaqueToTheClearestAndNoFurther() {
        XCTAssertEqual(GlassVeil(transparency: 0), GlassVeil(top: 1, bottom: 1))
        XCTAssertEqual(GlassVeil(transparency: 1), GlassVeil.clearest)
        XCTAssertEqual(GlassVeil(transparency: 3), GlassVeil.clearest)
        XCTAssertEqual(GlassVeil(transparency: -1), GlassVeil(top: 1, bottom: 1))
    }

    func testMoreTransparencyNeverDarkensTheVeil() {
        let veils = stride(from: 0.0, through: 1.0, by: 0.05).map { GlassVeil(transparency: $0) }
        for (a, b) in zip(veils, veils.dropFirst()) {
            XCTAssertGreaterThanOrEqual(a.top, b.top)
            XCTAssertGreaterThanOrEqual(a.bottom, b.bottom)
        }
    }
}
