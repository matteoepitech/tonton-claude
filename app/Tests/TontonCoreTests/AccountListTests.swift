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
        XCTAssertEqual(list.name(of: work), "Work")
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
        XCTAssertEqual(list.name(of: home), "Personal")
        list.rename(home, to: String(repeating: "x", count: 80))
        XCTAssertEqual(list.name(of: home).count, 40)
        list.rename(home, to: "   ")
        XCTAssertEqual(list.name(of: home), "relay.example.org · 77b2")
        // Renaming an account that isn't there changes nothing.
        list.rename(work, to: "Work")
        XCTAssertNil(list.entry(for: work))
    }

    func testRemovingAndDuplicatesFromDisk() {
        var list = AccountList([.init(account: work, name: "Work"), .init(account: work, name: "Copy"), .init(account: home, name: "Home")])
        XCTAssertEqual(list.entries.map(\.name), ["Work", "Home"])
        list.remove(work)
        XCTAssertEqual(list.entries.map(\.name), ["Home"])
    }
}
