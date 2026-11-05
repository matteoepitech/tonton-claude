import CoreGraphics
import XCTest

@testable import TontonCore

final class DropdownTests: XCTestCase {
    private let notch = CGSize(width: 700, height: 500)

    func testUnderTheButtonAlignedWithItsNearerEdge() {
        let left = Dropdown.frame(ideal: CGSize(width: 200, height: 120), button: CGRect(x: 40, y: 60, width: 30, height: 20), in: notch)
        XCTAssertEqual(left, CGRect(x: 40, y: 84, width: 200, height: 120))
        let right = Dropdown.frame(ideal: CGSize(width: 200, height: 120), button: CGRect(x: 600, y: 60, width: 30, height: 20), in: notch)
        XCTAssertEqual(right.maxX, 630)
        XCTAssertEqual(right.minY, 84)
    }

    func testOverTheButtonWhenThereIsMoreRoomAbove() {
        let frame = Dropdown.frame(ideal: CGSize(width: 200, height: 160), button: CGRect(x: 40, y: 420, width: 30, height: 20), in: notch)
        XCTAssertEqual(frame.maxY, 416)
        XCTAssertEqual(frame.height, 160)
    }

    func testKeptInsideTheNotchAndCappedToTheRoom() {
        let frame = Dropdown.frame(ideal: CGSize(width: 200, height: 900), button: CGRect(x: 690, y: 40, width: 8, height: 20), in: notch)
        XCTAssertEqual(frame.maxX, 694)
        XCTAssertEqual(frame.minY, 64)
        XCTAssertEqual(frame.maxY, 494)
        let wide = Dropdown.frame(ideal: CGSize(width: 900, height: 50), button: CGRect(x: 10, y: 10, width: 8, height: 20), in: notch)
        XCTAssertEqual(wide.minX, 6)
        XCTAssertEqual(wide.width, 688)
    }

    func testTheArrowsWrapAround() {
        let ids = ["live", "digest", "muted"]
        XCTAssertEqual(Dropdown.step(ids, from: nil, by: 1), "live")
        XCTAssertEqual(Dropdown.step(ids, from: nil, by: -1), "muted")
        XCTAssertEqual(Dropdown.step(ids, from: "live", by: 1), "digest")
        XCTAssertEqual(Dropdown.step(ids, from: "muted", by: 1), "live")
        XCTAssertEqual(Dropdown.step(ids, from: "live", by: -1), "muted")
        XCTAssertEqual(Dropdown.step(ids, from: "gone", by: 1), "live")
        XCTAssertNil(Dropdown.step([String](), from: nil, by: 1))
    }
}
