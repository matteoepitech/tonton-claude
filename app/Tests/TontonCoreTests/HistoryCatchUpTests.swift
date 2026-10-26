import XCTest

@testable import TontonCore

final class HistoryCatchUpTests: XCTestCase {
    func testEachSessionOnceThenBackToTheSelectedOne() {
        var catchUp = HistoryCatchUp()
        XCTAssertEqual(catchUp.start(sessions: ["a", "b", "c"], selected: "b"), "a")
        XCTAssertTrue(catchUp.isRunning)
        // A history for another session, such as the selected one's, does not move it on.
        XCTAssertEqual(catchUp.received("b"), "a")
        XCTAssertEqual(catchUp.received("a"), "c")
        XCTAssertNil(catchUp.received("c"))
        XCTAssertFalse(catchUp.isRunning)
        // The next search only fetches sessions it has not seen, never the selected one.
        XCTAssertEqual(catchUp.start(sessions: ["a", "b", "c", "d"], selected: "b"), "d")
        XCTAssertNil(catchUp.received("d"))
        XCTAssertNil(catchUp.start(sessions: ["a", "b", "c", "d"], selected: "b"))
    }

    func testOneRunAtATimeAndACancelledOneStartsOver() {
        var catchUp = HistoryCatchUp()
        XCTAssertEqual(catchUp.start(sessions: ["a", "b"], selected: nil), "a")
        XCTAssertNil(catchUp.start(sessions: ["a", "b", "c"], selected: nil))
        catchUp.cancel()
        XCTAssertFalse(catchUp.isRunning)
        XCTAssertEqual(catchUp.start(sessions: ["a", "b"], selected: nil), "b")
    }
}
