import XCTest

@testable import TontonCore

final class RelayLatencyTests: XCTestCase {
    func testLevels() {
        XCTAssertEqual(RelayLatency(milliseconds: 40, region: nil).level, .good)
        XCTAssertEqual(RelayLatency(milliseconds: 150, region: nil).level, .fair)
        XCTAssertEqual(RelayLatency(milliseconds: 399, region: nil).level, .fair)
        XCTAssertEqual(RelayLatency(milliseconds: 400, region: nil).level, .high)
    }

    func testLabel() {
        XCTAssertEqual(RelayLatency(milliseconds: 42, region: "Paris").label, "Paris · 42 ms")
        XCTAssertEqual(RelayLatency(milliseconds: 42, region: nil).label, "42 ms")
        XCTAssertEqual(RelayLatency(milliseconds: 0, region: nil).label, "<1 ms")
    }
}
