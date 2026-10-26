import XCTest

@testable import TontonCore

final class DictationTextTests: XCTestCase {
    func testDictatedWordsFollowWhatWasTyped() {
        XCTAssertEqual(DictationText.merge(typed: "", transcript: "Run the tests"), "Run the tests")
        XCTAssertEqual(DictationText.merge(typed: "Then", transcript: "run the tests"), "Then run the tests")
        XCTAssertEqual(DictationText.merge(typed: "Then ", transcript: "run the tests"), "Then run the tests")
        XCTAssertEqual(DictationText.merge(typed: "Line\n", transcript: "next"), "Line\nnext")
        XCTAssertEqual(DictationText.merge(typed: "Kept", transcript: "  "), "Kept")
    }
}
