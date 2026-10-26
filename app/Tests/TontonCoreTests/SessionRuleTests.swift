import XCTest

@testable import TontonCore

final class SessionRuleTests: XCTestCase {
    private struct Table: Decodable {
        struct Case: Decodable {
            let tool: String
            let preview: String
            let label: String?
            let rules: [PermissionRule]?
        }
        let cases: [Case]
    }

    /// The same table as shared/test/session-rule.test.ts: the web app offers what the notch offers.
    func testWhatTheButtonOffersIsWhatTheWebAppOffers() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../shared/test/session-rules.json")
        let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(table.cases.count, 5)
        for item in table.cases {
            let rule = SessionRule.suggested(tool: item.tool, inputPreview: item.preview)
            XCTAssertEqual(rule?.label, item.label, item.preview)
            XCTAssertEqual(rule?.rules, item.rules, item.preview)
        }
    }

    func testTheRulesAreSealedForTheirSessionAndRequest() throws {
        let key = E2E.newKey()
        let symmetric = try E2E.key(fromBase64URL: key)
        let rules = [PermissionRule(tool: "Bash", pattern: "npm test")]
        let sealed = try SessionVault(key: symmetric).sealSessionRules(rules, for: "ses_1", requestId: "r1")
        let opened = try E2E.open(sealed, as: SessionRules.self, with: symmetric)
        XCTAssertEqual([opened.sessionId, opened.requestId], ["ses_1", "r1"])
        XCTAssertEqual(opened.rules, rules)
    }
}
