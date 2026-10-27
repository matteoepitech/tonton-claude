import XCTest

@testable import TontonCore

final class FocusSilenceTests: XCTestCase {
    func testEachAlertHasItsKind() {
        XCTAssertEqual(FocusSilence.Event.of(.idle, finished: true), .finished)
        XCTAssertEqual(FocusSilence.Event.of(.permission, finished: false), .permission)
        XCTAssertEqual(FocusSilence.Event.of(.waiting, finished: false), .needsYou)
        XCTAssertEqual(FocusSilence.Event.of(.error, finished: false), .needsYou)
    }

    func testOnlyThePickedKindsAreSilenced() {
        let focus = FocusSilence(events: [.finished, .permission])
        XCTAssertTrue(focus.silences(.finished))
        XCTAssertTrue(focus.silences(.permission))
        XCTAssertFalse(focus.silences(.needsYou))
        XCTAssertFalse(focus.silences(.limitReset))
        XCTAssertFalse(focus.silences(.other))
        XCTAssertTrue(FocusSilence.Event.allCases.allSatisfy { !FocusSilence.none.silences($0) })
    }

    func testTheSummarySaysWhatIsSilenced() {
        XCTAssertEqual(FocusSilence.none.summary, "Silences nothing")
        XCTAssertEqual(FocusSilence(events: Set(FocusSilence.Event.allCases)).summary, "Silences every alert")
        // In a fixed order, whatever the order they were picked in.
        XCTAssertEqual(
            FocusSilence(events: [.permission, .finished, .needsYou]).summary,
            "Silences: finished tasks, questions and errors, permission requests")
    }
}
