import XCTest

@testable import TontonCore

final class SaveFailureTests: XCTestCase {
    func testAFailedWriteSaysWhichFileAndWhy() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("save-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let ok = folder.appendingPathComponent("export.md")
        XCTAssertNil(SaveFailure.write(Data("# Hi".utf8), to: ok))
        XCTAssertEqual(try String(contentsOf: ok, encoding: .utf8), "# Hi")
        // A folder that does not exist, as a removed disk or a moved folder leaves it.
        let missing = folder.appendingPathComponent("gone/wrapped.png")
        let message = try XCTUnwrap(SaveFailure.write(Data([1, 2]), to: missing))
        XCTAssertTrue(message.hasPrefix("Could not save wrapped.png: "), message)
        XCTAssertGreaterThan(message.count, "Could not save wrapped.png: ".count)
    }
}
