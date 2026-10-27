import CryptoKit
import XCTest

@testable import TontonCore

final class ConversationArchiveTests: XCTestCase {
    private var directory: URL!
    private let start = Date(timeIntervalSince1970: 1_793_000_000)

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("archive-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func conversation(
        _ id: String, at offset: TimeInterval, saying text: String = "Ship the release notes"
    ) -> ConversationArchive.Conversation {
        let entries = [
            Entry(id: "\(id)-u", ts: "2026-10-27T10:00:00Z", kind: .user, text: "Please \(text)"),
            Entry(id: "\(id)-t", ts: "2026-10-27T10:00:02Z", kind: .tool, toolUseId: "toolu", name: "Bash", summary: "make release"),
            Entry(id: "\(id)-r", ts: "2026-10-27T10:00:03Z", kind: .toolResult, text: "secret build output", toolUseId: "toolu"),
            Entry(id: "\(id)-a", ts: "2026-10-27T10:00:05Z", kind: .assistant, text: "Done."),
        ]
        let summary = ConversationArchive.Summary(
            id: id, project: "api", machine: "MacBook", title: nil, archivedAt: start + offset, messages: 2)
        return ConversationArchive.Conversation(summary: summary, entries: entries)
    }

    private func files(in folder: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).sorted()
    }

    func testConversationsAreSealedAndReadBackWithTheirKeyOnly() throws {
        let keyFile = directory.appendingPathComponent("archive.key")
        let key = try ConversationArchive.key(at: keyFile)
        XCTAssertEqual(try ConversationArchive.key(at: keyFile), key)
        let archive = ConversationArchive(directory: directory.appendingPathComponent("Archive"), key: key)
        try archive.save(conversation("s1", at: 0))
        XCTAssertEqual(archive.load("s1"), conversation("s1", at: 0))
        // Nothing readable on disk, and only the user can read it.
        for name in files(in: archive.directory) {
            let file = archive.directory.appendingPathComponent(name)
            XCTAssertFalse(try String(contentsOf: file, encoding: .utf8).contains("release notes"))
            XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int, 0o600)
        }
        XCTAssertNil(ConversationArchive(directory: archive.directory, key: SymmetricKey(size: .bits256)).load("s1"))
    }

    func testAKeyFileThatCannotBeReadIsAnErrorNotANewKey() throws {
        let keyFile = directory.appendingPathComponent("archive.key")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data([0xFF, 0xFE, 0x00]).write(to: keyFile)
        XCTAssertThrowsError(try ConversationArchive.key(at: keyFile)) { error in
            XCTAssertEqual(error as? ConversationArchive.Failure, .unreadableKey)
        }
        XCTAssertEqual(try Data(contentsOf: keyFile), Data([0xFF, 0xFE, 0x00]))
    }

    func testTheListIsTheLatestFirstAndASessionArchivedAgainReplacesItself() throws {
        let archive = ConversationArchive(directory: directory, key: SymmetricKey(size: .bits256))
        XCTAssertEqual(try archive.list(), [])
        try archive.save(conversation("s1", at: 0))
        try archive.save(conversation("s2", at: 60))
        try archive.save(conversation("s1", at: 120, saying: "fix the tests"))
        XCTAssertEqual(try archive.list().map(\.id), ["s1", "s2"])
        XCTAssertEqual(archive.load("s1")?.entries.first?.text, "Please fix the tests")
        try archive.delete("s2")
        XCTAssertEqual(try archive.list().map(\.id), ["s1"])
        XCTAssertNil(archive.load("s2"))
        archive.deleteAll()
        XCTAssertEqual(try archive.list(), [])
    }

    func testOnlyTheMostRecentOnesAreKept() throws {
        let archive = ConversationArchive(directory: directory, key: SymmetricKey(size: .bits256))
        for index in 0...ConversationArchive.kept { try archive.save(conversation("s\(index)", at: TimeInterval(index))) }
        XCTAssertEqual(try archive.list().count, ConversationArchive.kept)
        XCTAssertNil(archive.load("s0"))
        XCTAssertNotNil(archive.load("s1"))
        XCTAssertEqual(files(in: directory).count, ConversationArchive.kept + 1)
    }

    func testAnUnreadableIndexIsNeverWrittenOver() throws {
        let archive = ConversationArchive(directory: directory, key: SymmetricKey(size: .bits256))
        try archive.save(conversation("s1", at: 0))
        try Data("not sealed".utf8).write(to: directory.appendingPathComponent("index.sealed"))
        XCTAssertThrowsError(try archive.list())
        XCTAssertThrowsError(try archive.save(conversation("s2", at: 60)))
        XCTAssertThrowsError(try archive.delete("s1"))
        // Nothing is swept either: the files may be all that is left.
        archive.sweep()
        XCTAssertNotNil(archive.load("s1"))
    }

    func testAMissingIndexIsMadeAgainFromTheConversationsNotSweptAway() throws {
        let archive = ConversationArchive(directory: directory, key: SymmetricKey(size: .bits256))
        try archive.save(conversation("s1", at: 0))
        try archive.save(conversation("s2", at: 60))
        try FileManager.default.removeItem(at: directory.appendingPathComponent("index.sealed"))
        try archive.save(conversation("s3", at: 120))
        archive.sweep()
        XCTAssertEqual(try archive.list().map(\.id), ["s3", "s2", "s1"])
        XCTAssertNotNil(archive.load("s1"))
    }

    func testAnIndexFromBeforeLastEntryStillReads() throws {
        let json = #"[{"id":"s1","project":"api","machine":"Mac","archivedAt":0,"messages":2}]"#
        let summaries = try JSONDecoder().decode([ConversationArchive.Summary].self, from: Data(json.utf8))
        XCTAssertNil(summaries.first?.lastEntry)
    }

    func testFilesTheIndexDoesNotListAreSwept() throws {
        let archive = ConversationArchive(directory: directory, key: SymmetricKey(size: .bits256))
        try archive.save(conversation("s1", at: 0))
        try Data("left by a crash".utf8).write(to: directory.appendingPathComponent("0123456789abcdef.sealed"))
        try Data("half".utf8).write(to: directory.appendingPathComponent("0123.sealed.partial"))
        archive.sweep()
        XCTAssertEqual(files(in: directory).count, 2)
        XCTAssertNotNil(archive.load("s1"))
    }

    func testTheSearchIndexReadsMessagesAndCallsButNotToolOutput() throws {
        let archive = ConversationArchive(directory: directory, key: SymmetricKey(size: .bits256))
        try archive.save(conversation("s1", at: 0, saying: "migrate the Données"))
        try archive.save(conversation("s2", at: 60))
        let index = ArchiveSearchIndex(archive, ids: try archive.list().map(\.id))
        let matches = index.search("DONNEES")
        XCTAssertEqual(matches.map(\.sessionId), ["s1"])
        XCTAssertEqual(matches.first?.snippet, "Please migrate the Données")
        XCTAssertEqual(index.search("make release").map(\.sessionId), ["s2", "s1"])
        XCTAssertEqual(index.search("secret build"), [])
        XCTAssertEqual(index.search("re"), [])
    }
}
