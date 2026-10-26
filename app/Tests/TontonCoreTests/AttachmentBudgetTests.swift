import XCTest

@testable import TontonCore

final class AttachmentBudgetTests: XCTestCase {
    func testFilesUpToTheBudget() {
        XCTAssertTrue(AttachmentBudget.fits([1_000_000, 3_000_000]))
        XCTAssertFalse(AttachmentBudget.fits([1_000_000, 3_000_001]))
        XCTAssertNil(AttachmentBudget.problem(adding: "a.pdf", bytes: 1_000_000, to: [2_000_000]))
    }

    func testWhyAFileIsRefused() {
        let tooBig = AttachmentBudget.problem(adding: "clip.mov", bytes: 120_000_000, to: [])
        XCTAssertEqual(tooBig, "clip.mov is 120 MB: a message carries up to 4 MB.")
        let full = AttachmentBudget.problem(adding: "b.zip", bytes: 2_000_000, to: [3_000_000])
        XCTAssertEqual(full, "b.zip does not fit: this message already carries 3 MB of 4 MB.")
    }
}
