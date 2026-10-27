import XCTest

@testable import TontonCore

final class UndoSendTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_793_000_000)
    private let image = OutgoingImage(name: "a.png", mediaType: "image/png", data: "iVBORw0K")

    func testWithoutADelayTheMessageGoesRightAway() {
        var queue = UndoSendQueue()
        XCTAssertNil(queue.hold("hi", images: [], to: "s1", delay: .off, now: start))
        XCTAssertTrue(queue.held.isEmpty)
        XCTAssertNil(queue.nextDeadline)
    }

    func testAHeldMessageGoesOnceItsDelayIsOver() throws {
        var queue = UndoSendQueue()
        let held = try XCTUnwrap(queue.hold("Ship it", images: [image], to: "s1", delay: .five, now: start))
        XCTAssertEqual(queue.nextDeadline, start.addingTimeInterval(5))
        XCTAssertEqual(held.secondsLeft(at: start), 5)
        XCTAssertEqual(held.secondsLeft(at: start.addingTimeInterval(4.2)), 1)
        XCTAssertTrue(queue.due(at: start.addingTimeInterval(4.9)).isEmpty)
        let due = queue.due(at: start.addingTimeInterval(5))
        XCTAssertEqual(due.map(\.text), ["Ship it"])
        XCTAssertEqual(due.first?.images.map(\.name), ["a.png"])
        XCTAssertTrue(queue.held.isEmpty)
    }

    func testUndoTakesItBackWithItsAttachments() throws {
        var queue = UndoSendQueue()
        let held = try XCTUnwrap(queue.hold("oops", images: [image], to: "s1", delay: .three, now: start))
        let back = try XCTUnwrap(queue.undo(held.id))
        XCTAssertEqual(back.text, "oops")
        XCTAssertEqual(back.images.map(\.data), ["iVBORw0K"])
        XCTAssertTrue(queue.due(at: start.addingTimeInterval(10)).isEmpty)
        // Too late: it is gone already.
        XCTAssertNil(queue.undo(held.id))
    }

    func testSeveralMessagesGoInTheOrderTheyWereSent() throws {
        var queue = UndoSendQueue()
        _ = queue.hold("one", images: [], to: "s1", delay: .ten, now: start)
        _ = queue.hold("other session", images: [], to: "s2", delay: .three, now: start.addingTimeInterval(1))
        // The delay was shortened in between: the second message of s1 still goes after the first.
        let two = try XCTUnwrap(queue.hold("two", images: [], to: "s1", delay: .three, now: start.addingTimeInterval(2)))
        XCTAssertEqual(two.sendAt, start.addingTimeInterval(10))
        XCTAssertEqual(queue.held(for: "s1").map(\.text), ["one", "two"])
        XCTAssertEqual(queue.due(at: start.addingTimeInterval(4)).map(\.text), ["other session"])
        XCTAssertEqual(queue.due(at: start.addingTimeInterval(10)).map(\.text), ["one", "two"])
    }

    func testFlushHandsBackEverythingInOrder() {
        var queue = UndoSendQueue()
        _ = queue.hold("one", images: [], to: "s1", delay: .ten, now: start)
        _ = queue.hold("two", images: [], to: "s2", delay: .five, now: start)
        XCTAssertEqual(queue.flush().map(\.text), ["one", "two"])
        XCTAssertTrue(queue.held.isEmpty)
        XCTAssertEqual(UndoSendDelay.allCases.map(\.label), ["Off", "3 seconds", "5 seconds", "10 seconds"])
    }
}
