import XCTest

@testable import TontonCore

final class SessionNotesTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("notes-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testANoteSurvivesARestart() throws {
        var notes = SessionNotes()
        notes.set("Check the migration\nthen the tests", for: "ses_1")
        let url = folder.appendingPathComponent("Tonton Claude/notes.json")
        try notes.save(to: url)
        let loaded = SessionNotes.load(from: url)
        XCTAssertEqual(loaded.text(for: "ses_1"), "Check the migration\nthen the tests")
        XCTAssertEqual(loaded, notes)
        let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        XCTAssertEqual(permissions, 0o600)
    }

    func testABlankNoteIsRemoved() {
        var notes = SessionNotes()
        notes.set("x", for: "ses_1")
        XCTAssertTrue(notes.has("ses_1"))
        notes.set("  \n ", for: "ses_1")
        XCTAssertFalse(notes.has("ses_1"))
        XCTAssertEqual(notes.text(for: "ses_1"), "")
    }

    func testNotesAreCutAndTheOldestGoFirst() {
        var notes = SessionNotes()
        notes.set(String(repeating: "a", count: SessionNotes.maxLength + 50), for: "long")
        XCTAssertEqual(notes.text(for: "long").count, SessionNotes.maxLength)
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        for index in 0..<SessionNotes.maxSessions {
            notes.set("note \(index)", for: "ses_\(index)", at: start.addingTimeInterval(Double(index)))
        }
        // "long" was edited now, after every other: the oldest of the others goes.
        XCTAssertEqual(notes.notes.count, SessionNotes.maxSessions)
        XCTAssertTrue(notes.has("long"))
        XCTAssertFalse(notes.has("ses_0"))
        XCTAssertTrue(notes.has("ses_1"))
    }

    func testTheSearchFindsTheNote() {
        var notes = SessionNotes()
        notes.set("Ask about the Stripe webhook", for: "ses_1")
        XCTAssertTrue(notes.matches("ses_1", "stripe"))
        XCTAssertFalse(notes.matches("ses_1", "paypal"))
        XCTAssertFalse(notes.matches("ses_2", "stripe"))
        XCTAssertFalse(notes.matches("ses_1", ""))
    }

    func testAnUnreadableFileGivesNoNotes() throws {
        let url = folder.appendingPathComponent("notes.json")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: url)
        XCTAssertEqual(SessionNotes.load(from: url), SessionNotes())
        XCTAssertEqual(SessionNotes.load(from: folder.appendingPathComponent("missing.json")), SessionNotes())
    }
}
