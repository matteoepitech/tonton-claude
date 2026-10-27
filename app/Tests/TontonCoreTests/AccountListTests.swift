import XCTest

@testable import TontonCore

final class AccountListTests: XCTestCase {
    private let work = Account(relay: "https://tonton.d3l.tech", accountId: "3f9a1c", token: "ta_work", key: "k1")
    private let home = Account(relay: "https://relay.example.org", accountId: "77b2d0", token: "ta_home", key: "k2")

    func testAccountsAreKeptOnceWithTheirLatestKeys() {
        var list = AccountList()
        list.save(work)
        list.save(home)
        XCTAssertEqual(list.entries.map(\.name), ["tonton.d3l.tech · 3f9a", "relay.example.org · 77b2"])
        // A regenerated token: same account, new key, same name.
        list.rename(work, to: "Work")
        list.save(work.with(key: "k3", joinSecret: "s"))
        XCTAssertEqual(list.entries.count, 2)
        XCTAssertEqual(list.entry(for: work)?.account.key, "k3")
        XCTAssertEqual(list.entry(for: work)?.name, "Work")
    }

    func testTheSameIdOnAnotherRelayIsAnotherAccount() {
        var list = AccountList()
        list.save(work)
        list.save(Account(relay: "https://other.example", accountId: work.accountId, token: "ta_x", key: "k"))
        XCTAssertEqual(list.entries.count, 2)
    }

    func testNamesAreTrimmedAndAnEmptyOneGoesBackToTheDefault() {
        var list = AccountList()
        list.save(home)
        list.rename(home, to: "  Personal  ")
        XCTAssertEqual(list.entry(for: home)?.name, "Personal")
        list.rename(home, to: String(repeating: "x", count: 80))
        XCTAssertEqual(list.entry(for: home)?.name.count, 40)
        list.rename(home, to: "   ")
        XCTAssertEqual(list.entry(for: home)?.name, "relay.example.org · 77b2")
        // Renaming an account that isn't there changes nothing.
        list.rename(work, to: "Work")
        XCTAssertNil(list.entry(for: work))
    }

    func testRemovingAndDuplicatesFromDisk() {
        var list = AccountList([.init(account: work, name: "Work"), .init(account: work, name: "Copy"), .init(account: home, name: "Home")])
        XCTAssertEqual(list.entries.map(\.name), ["Work", "Home"])
        XCTAssertEqual(list.sorted.map(\.name), ["Home", "Work"])
        list.remove(work)
        XCTAssertEqual(list.entries.map(\.name), ["Home"])
    }
}

final class AccountFilesTests: XCTestCase {
    private var directory: URL!
    private let work = Account(relay: "https://tonton.d3l.tech", accountId: "3f9a1c", token: "ta_work", key: "k1")
    private let home = Account(relay: "https://relay.example.org", accountId: "77b2d0", token: "ta_home", key: "k2")

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("accounts-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func permissions(_ url: URL) throws -> Int {
        try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int)
    }

    func testEachAccountHasAFileOnlyTheUserCanRead() throws {
        let files = AccountFiles(directory: directory)
        var list = AccountList()
        list.save(work)
        list.save(home)
        list.rename(home, to: "Personal")
        files.save(list)
        XCTAssertEqual(files.load(), list)
        XCTAssertEqual(try permissions(directory), 0o700)
        for entry in list.entries { XCTAssertEqual(try permissions(files.file(for: entry.id)), 0o600) }
        // The file names say nothing about the accounts.
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).joined()
        XCTAssertFalse(names.contains("3f9a1c") || names.contains("tonton"))
    }

    func testNewKeysReachTheFileAndSignedOutAccountsLeave() throws {
        let files = AccountFiles(directory: directory)
        var list = AccountList()
        list.save(work)
        list.save(home)
        files.save(list)
        list.save(work.with(key: "k3", joinSecret: "s"))
        list.remove(home)
        files.save(list)
        XCTAssertEqual(files.load().entries.map(\.account.key), ["k3"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1)
    }

    func testAFileThisVersionCannotReadIsLeftAlone() throws {
        let files = AccountFiles(directory: directory)
        var list = AccountList()
        list.save(work)
        files.save(list)
        let newer = directory.appendingPathComponent("abcdef.json")
        try Data(#"{"format":2,"secret":"only copy"}"#.utf8).write(to: newer)
        files.save(list)
        XCTAssertTrue(FileManager.default.fileExists(atPath: newer.path))
        XCTAssertEqual(files.load().entries.count, 1)
    }

    func testAnUnchangedAccountIsNotWrittenAgain() throws {
        let files = AccountFiles(directory: directory)
        var list = AccountList()
        list.save(work)
        files.save(list)
        let url = files.file(for: AccountList.id(of: work))
        let before = try FileManager.default.attributesOfItem(atPath: url.path)[.systemFileNumber] as? Int
        files.save(files.load())
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: url.path)[.systemFileNumber] as? Int, before)
    }
}
