import XCTest

@testable import TontonCore

final class MachineStyleTests: XCTestCase {
    func testSymbolsAndEmoji() {
        XCTAssertFalse(MachineStyle(symbol: "gamecontroller").isEmoji)
        XCTAssertTrue(MachineStyle(symbol: "🎮").isEmoji)
        XCTAssertTrue(MachineStyle().isEmpty)
        XCTAssertFalse(MachineStyle(color: 2).isEmpty)
        XCTAssertEqual(MachineStyle.emoji(in: "my 🖥️ gaming pc"), "🖥️")
        XCTAssertEqual(MachineStyle.emoji(in: "🚀"), "🚀")
        XCTAssertNil(MachineStyle.emoji(in: "pc"))
    }

    func testStylesSurviveARoundTrip() throws {
        let styles = ["m1": MachineStyle(symbol: "server.rack", color: 3), "m2": MachineStyle(symbol: "🎮")]
        XCTAssertEqual(try JSONDecoder().decode([String: MachineStyle].self, from: try JSONEncoder().encode(styles)), styles)
    }
}
