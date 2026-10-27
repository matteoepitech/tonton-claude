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

    func testOneSessionCanBeFetchedAgainToArchiveIt() {
        var catchUp = HistoryCatchUp()
        // Visited before by a search: fetched again all the same.
        XCTAssertEqual(catchUp.start(sessions: ["a"], selected: nil), "a")
        XCTAssertNil(catchUp.received("a"))
        XCTAssertEqual(catchUp.fetch("a", selected: nil), "a")
        XCTAssertNil(catchUp.received("a"))
        // The selected one is followed already.
        XCTAssertNil(catchUp.fetch("b", selected: "b"))
        // While a catch-up runs, it joins the queue.
        XCTAssertEqual(catchUp.start(sessions: ["c", "d"], selected: nil), "c")
        XCTAssertNil(catchUp.fetch("e", selected: nil))
        XCTAssertEqual(catchUp.received("c"), "d")
        XCTAssertEqual(catchUp.received("d"), "e")
        XCTAssertNil(catchUp.received("e"))
    }

    func testASearchStartedDuringAnArchiveFetchJoinsTheQueue() {
        var catchUp = HistoryCatchUp()
        XCTAssertEqual(catchUp.fetch("a", selected: nil), "a")
        XCTAssertNil(catchUp.start(sessions: ["a", "b", "c"], selected: "c"))
        XCTAssertEqual(catchUp.received("a"), "b")
        XCTAssertNil(catchUp.received("b"))
    }
}
