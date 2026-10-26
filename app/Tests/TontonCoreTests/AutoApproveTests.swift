import CryptoKit
import XCTest

@testable import TontonCore

final class AutoApproveTests: XCTestCase {
    func testEachMachineGetsTheRulesForAllAndItsOwn() {
        let rules = [
            AutoApproveRule(tool: "Bash", pattern: " npm test* ", machineId: nil),
            AutoApproveRule(tool: "Read", pattern: "", machineId: "m1"),
            AutoApproveRule(tool: "WebFetch", pattern: "https://docs.example.com/*", machineId: "m2"),
        ]
        XCTAssertEqual(
            AutoApproveRule.rules(rules, for: "m1"),
            [PermissionRule(tool: "Bash", pattern: "npm test*"), PermissionRule(tool: "Read", pattern: nil)])
        XCTAssertEqual(AutoApproveRule.rules(rules, for: "m3"), [PermissionRule(tool: "Bash", pattern: "npm test*")])
    }

    func testRulesAreSealedWithTheirDateForTheAgent() throws {
        let key = SymmetricKey(size: .bits256)
        let date = Date(timeIntervalSince1970: 1_793_005_200)
        let blob = try SessionVault(key: key).sealRules([PermissionRule(tool: "Bash", pattern: nil)], issuedAt: date)
        let set = try E2E.open(blob, as: RuleSet.self, with: key)
        XCTAssertEqual(set.rules, [PermissionRule(tool: "Bash", pattern: nil)])
        XCTAssertEqual(set.issuedAt, "2026-10-26T09:00:00Z")
        // The agent reads a missing pattern as "any call": no `pattern: null` in the JSON.
        let json = String(decoding: try JSONEncoder().encode(PermissionRule(tool: "Bash", pattern: nil)), as: UTF8.self)
        XCTAssertEqual(json, #"{"tool":"Bash"}"#)
    }
}
