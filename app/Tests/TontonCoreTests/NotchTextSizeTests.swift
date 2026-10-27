import XCTest

@testable import TontonCore

final class NotchTextSizeTests: XCTestCase {
    func testDefaultKeepsTheDesignSizes() {
        for size in [8.0, 9, 10, 11, 11.5, 12, 13, 15, 26] {
            XCTAssertEqual(NotchTextSize.standard.points(size), size)
        }
    }

    func testSmallAndLargeScaleEveryTextTheSameWay() {
        XCTAssertEqual(NotchTextSize.large.points(10), 12)
        XCTAssertEqual(NotchTextSize.large.points(12), 14.5)
        XCTAssertEqual(NotchTextSize.small.points(12), 11)
        XCTAssertEqual(NotchTextSize.small.points(10), 9)
        // Sizes stay in order, so headings stay bigger than captions.
        for choice in NotchTextSize.allCases {
            let sizes = [8.0, 9, 10, 11, 12, 13, 15].map(choice.points)
            XCTAssertEqual(sizes, sizes.sorted(), "\(choice)")
            XCTAssertEqual(Set(sizes).count, sizes.count, "\(choice): two design sizes became one")
        }
    }

    func testSizesFallOnHalfPoints() {
        for choice in NotchTextSize.allCases {
            for size in stride(from: 8.0, through: 26, by: 0.5) {
                let points = choice.points(size)
                XCTAssertEqual(points * 2, (points * 2).rounded(), "\(choice) \(size)")
            }
        }
    }

    func testTheChoiceIsSavedByName() {
        XCTAssertEqual(NotchTextSize.allCases.map(\.rawValue), ["small", "standard", "large"])
        XCTAssertEqual(NotchTextSize.allCases.map(\.label), ["Small", "Default", "Large"])
    }
}
