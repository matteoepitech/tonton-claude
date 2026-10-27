import XCTest

@testable import TontonCore

final class PreviewFileTests: XCTestCase {
    func testAttachmentsKeepTheirNameButNeverAPath() {
        XCTAssertEqual(PreviewFile.name("screenshot.png"), "screenshot.png")
        XCTAssertEqual(PreviewFile.name("../../.ssh/config"), "config")
        XCTAssertEqual(PreviewFile.name("/etc/passwd"), "passwd")
        XCTAssertEqual(PreviewFile.name("a:b.txt"), "a-b.txt")
        XCTAssertEqual(PreviewFile.name(".env"), "attachment.env")
        XCTAssertEqual(PreviewFile.name(""), "attachment")
        XCTAssertEqual(PreviewFile.name("dir/"), "dir")
    }
}
