import XCTest

@testable import TontonCore

final class SwipeToAnswerTests: XCTestCase {
    func testAShortSwipeSpringsBack() {
        var swipe = SwipeToAnswer()
        swipe.move(by: 50)
        XCTAssertNil(swipe.answer)
        XCTAssertEqual(swipe.offset, 50)
        XCTAssertEqual(swipe.progress, 0.625)
        swipe.move(by: -120)
        XCTAssertNil(swipe.answer)
    }

    func testPastTheThresholdRightAllowsAndLeftDenies() {
        var swipe = SwipeToAnswer()
        swipe.move(by: SwipeToAnswer.threshold)
        XCTAssertEqual(swipe.answer, true)
        // Back to the middle: no answer any more.
        swipe.move(by: -SwipeToAnswer.threshold)
        XCTAssertNil(swipe.answer)
        swipe.move(by: -SwipeToAnswer.threshold)
        XCTAssertEqual(swipe.answer, false)
    }

    func testTheCardResistsPastTheThreshold() {
        var swipe = SwipeToAnswer()
        swipe.move(by: SwipeToAnswer.threshold + 100)
        XCTAssertEqual(swipe.offset, SwipeToAnswer.threshold + 30)
        XCTAssertEqual(swipe.progress, 1)
        var left = SwipeToAnswer()
        left.move(by: -(SwipeToAnswer.threshold + 100))
        XCTAssertEqual(left.offset, -(SwipeToAnswer.threshold + 30))
    }
}
