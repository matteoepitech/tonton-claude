import CryptoKit
import XCTest

@testable import TontonCore

final class TurnLedgerTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_793_000_000)
    private func at(_ minutes: Double) -> Date { start + minutes * 60 }

    func testATurnThatEndedWhileTheMacWasAwayCountsOnce() {
        var ledger = TurnLedger(since: start)
        let away = [Turn(end: at(30), seconds: 1200), Turn(end: at(50), seconds: 600)]
        XCTAssertEqual(ledger.reported(session: "s", turns: away, now: at(60)), away)
        // The same turns come back with every meta.
        let next = Turn(end: at(70), seconds: 60)
        XCTAssertEqual(ledger.reported(session: "s", turns: away + [next], now: at(71)), [next])
    }

    func testATurnTheAppSawEndIsNotCountedAgainWhenReported() {
        var ledger = TurnLedger(since: start)
        XCTAssertTrue(ledger.live(session: "s", end: at(10) + 4))
        XCTAssertEqual(ledger.reported(session: "s", turns: [Turn(end: at(10), seconds: 300)], now: at(11)), [])
        // Reported first, then seen: the status can come after the meta.
        let turn = Turn(end: at(20), seconds: 300)
        XCTAssertEqual(ledger.reported(session: "s", turns: [turn], now: at(20)), [turn])
        XCTAssertFalse(ledger.live(session: "s", end: at(20) + 3))
    }

    func testTwoShortTurnsCloseTogetherStayTwo() {
        var ledger = TurnLedger(since: start)
        XCTAssertTrue(ledger.live(session: "s", end: at(10)))
        XCTAssertTrue(ledger.live(session: "s", end: at(11)))
        // Each report pairs with one live task only.
        let turns = [Turn(end: at(10) - 2, seconds: 20), Turn(end: at(11) - 2, seconds: 20), Turn(end: at(11.5), seconds: 20)]
        XCTAssertEqual(ledger.reported(session: "s", turns: turns, now: at(12)), [Turn(end: at(11.5), seconds: 20)])
        // Another session is another story.
        XCTAssertTrue(ledger.live(session: "t", end: at(11.5)))
    }

    func testTurnsFromBeforeThisVersionOrTooOldAreLeftOut() {
        var ledger = TurnLedger(since: start)
        XCTAssertEqual(ledger.reported(session: "s", turns: [Turn(end: at(-5), seconds: 60)], now: at(1)), [])
        let late = at(15 * 24 * 60)
        XCTAssertEqual(ledger.reported(session: "s", turns: [Turn(end: at(10), seconds: 60), Turn(end: late, seconds: 0)], now: late), [])
    }

    func testItIsSavedWithItsMarks() throws {
        var ledger = TurnLedger(since: start)
        _ = ledger.reported(session: "s", turns: [Turn(end: at(30), seconds: 60)], now: at(31))
        var saved = try JSONDecoder().decode(TurnLedger.self, from: JSONEncoder().encode(ledger))
        XCTAssertEqual(saved, ledger)
        XCTAssertEqual(saved.reported(session: "s", turns: [Turn(end: at(30), seconds: 60)], now: at(32)), [])
    }

    func testTheAgentsTurnsReachTheSession() throws {
        let key = SymmetricKey(size: .bits256)
        func session(_ meta: SessionMeta) throws -> SessionSummary {
            let json = """
                {"id":"s1","machineId":"m1","status":"idle","agentOnline":true,"canChat":true,"meta":"\(try E2E.seal(meta, with: key))",
                 "pendingPermissions":[],"startedAt":"2026-10-25T10:00:00Z","lastActivity":"2026-10-25T10:00:00Z"}
                """
            return SessionVault(key: key).session(try JSONDecoder().decode(WireSession.self, from: Data(json.utf8)), machines: [])
        }
        var meta = SessionMeta(title: nil, costUSD: nil, lastMessage: nil)
        XCTAssertNil(try session(meta).turns)
        meta.turns = [WireTurn(end: "2026-10-26T21:00:00.000Z", seconds: 754.3), WireTurn(end: "not a date", seconds: 1)]
        XCTAssertEqual(try session(meta).turns, [Turn(end: try XCTUnwrap(ISO8601.parse("2026-10-26T21:00:00.000Z")), seconds: 754.3)])
    }
}
