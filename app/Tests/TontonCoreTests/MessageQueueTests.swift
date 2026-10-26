import XCTest

@testable import TontonCore

final class MessageQueueTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    func testOneMessagePerTurn() {
        var queue = MessageQueue()
        queue.append(QueuedMessage(text: "one"))
        queue.append(QueuedMessage(text: "two"))
        XCTAssertNil(queue.next(status: .working, canChat: true, now: start))
        XCTAssertEqual(queue.next(status: .idle, canChat: true, now: start)?.text, "one")
        // Still idle until the turn it started shows up: nothing more.
        XCTAssertNil(queue.next(status: .idle, canChat: true, now: start + 1))
        XCTAssertNil(queue.next(status: .working, canChat: true, now: start + 2))
        XCTAssertEqual(queue.next(status: .idle, canChat: true, now: start + 30)?.text, "two")
        XCTAssertTrue(queue.isEmpty)
    }

    func testAQuestionOrAPermissionHoldsTheQueue() {
        var queue = MessageQueue()
        queue.append(QueuedMessage(text: "one"))
        XCTAssertNil(queue.next(status: .permission, canChat: true, now: start))
        XCTAssertNil(queue.next(status: .waiting, canChat: true, now: start))
        XCTAssertNil(queue.next(status: .idle, canChat: false, now: start))
    }

    func testATurnNeverSeenStartingDoesNotBlockForever() {
        var queue = MessageQueue()
        queue.append(QueuedMessage(text: "one"))
        queue.append(QueuedMessage(text: "two"))
        _ = queue.next(status: .idle, canChat: true, now: start)
        XCTAssertNil(queue.next(status: .idle, canChat: true, now: start + 30))
        XCTAssertEqual(queue.next(status: .idle, canChat: true, now: start + 61)?.text, "two")
    }

    func testReorderAndCancel() {
        var queue = MessageQueue()
        let (a, b, c) = (QueuedMessage(text: "a"), QueuedMessage(text: "b"), QueuedMessage(text: "c"))
        [a, b, c].forEach { queue.append($0) }
        queue.move(c.id, by: -1)
        XCTAssertEqual(queue.items.map(\.text), ["a", "c", "b"])
        queue.move(a.id, by: -1)
        XCTAssertEqual(queue.items.map(\.text), ["a", "c", "b"])
        queue.remove(c.id)
        XCTAssertEqual(queue.items.map(\.text), ["a", "b"])
    }
}
