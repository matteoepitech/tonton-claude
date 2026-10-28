import XCTest

@testable import TontonCore

/// Pool safety as the relay sends it (relay/src/pool-safety.ts): rules, budgets, the audit log, the revision each session
/// accepted; and the acceptance only the machine owner's account key seals.
final class PoolSafetyTests: XCTestCase {
    private func decode(_ json: String) throws -> PoolUpdate {
        try JSONDecoder().decode(PoolUpdate.self, from: Data(json.utf8))
    }

    func testRulesBudgetsAndTheAuditLogDecodeAsTheRelaySendsThem() throws {
        let item = #"{"rev":2,"updatedAt":"now","account":"owner","session":null,"blob":"sealed"}"#
        XCTAssertEqual(
            try decode(#"{"t":"pool_rules","poolId":"pool1","rules":\#(item)}"#),
            .rules(
                poolId: "pool1",
                PoolItemWire(id: nil, rev: 2, seq: nil, updatedAt: "now", ts: nil, account: "owner", session: nil, blob: "sealed")))
        guard case .budgets(_, let budgets) = try decode(#"{"t":"pool_budgets","poolId":"pool1","budgets":\#(item)}"#) else {
            return XCTFail("not budgets")
        }
        XCTAssertEqual(budgets.rev, 2)
        let line = #"{"seq":3,"ts":"now","account":"owner","session":null,"action":"stopped","target":{"account":"bob","session":"s1"}}"#
        guard case .audit(_, let entry) = try decode(#"{"t":"pool_audit","poolId":"pool1","entry":\#(line)}"#) else {
            return XCTFail("not an audit line")
        }
        XCTAssertEqual(entry.action, "stopped")
        XCTAssertEqual(entry.target?.session, "s1")

        let snapshot = """
            {"t":"pool_snapshot","pool":{"id":"pool1","createdAt":"now","paused":true,"keyVersion":1,"info":"sealed",
            "members":[],"sessions":[{"account":"bob","session":"s1","joinedAt":"now","profile":null,"online":true,"ready":true,
            "accepted":2}],"tasks":[],"notes":null,"messages":[],"events":[],"rules":\(item),"budgets":null,"audit":[\(line)]}}
            """
        guard case .snapshot(let pool) = try decode(snapshot) else { return XCTFail("not a snapshot") }
        XCTAssertEqual(pool.sessions.first?.accepted, 2)
        XCTAssertEqual(pool.rules?.rev, 2)
        XCTAssertEqual(pool.audit?.map(\.action), ["stopped"])
        // An older relay sends none of it.
        let older = """
            {"t":"pool_snapshot","pool":{"id":"pool1","createdAt":"now","paused":false,"keyVersion":1,"info":"sealed",
            "members":[],"sessions":[{"account":"bob","session":"s1","joinedAt":"now","profile":null,"online":true,"ready":true}],
            "tasks":[],"notes":null,"messages":[],"events":[]}}
            """
        guard case .snapshot(let old) = try decode(older) else { return XCTFail("not a snapshot") }
        XCTAssertNil(old.sessions.first?.accepted)
        XCTAssertNil(old.rules)
    }

    func testTheAcceptanceCopiesTheRulesInAndOpensWithTheAccountKeyOnly() throws {
        let accountKey = try E2E.key(fromBase64URL: E2E.newKey())
        let rules = [PermissionRule(tool: "Bash", pattern: "make deploy *")]
        let sealed = try SessionVault(key: accountKey).sealPoolRulesAcceptance(poolId: "pool1", sessionId: "s1", rev: 2, rules: rules)
        let opened = try E2E.open(sealed, as: PoolRulesAcceptance.self, with: accountKey)
        XCTAssertEqual(opened.rules, rules)
        XCTAssertEqual([opened.poolId, opened.sessionId], ["pool1", "s1"])
        XCTAssertEqual(opened.rev, 2)
        XCTAssertThrowsError(try E2E.open(sealed, as: PoolRulesAcceptance.self, with: try E2E.key(fromBase64URL: E2E.newKey())))
    }

    func testProposalsBudgetsAndSpendOpenWithThePoolKey() throws {
        let vault = try PoolVault(key: E2E.newKey())
        let budgets = PoolBudgets(pool: PoolBudget(costUSD: 50), members: ["bob": PoolBudget(hours: 2)])
        XCTAssertEqual(vault.open(try vault.seal(budgets), as: PoolBudgets.self), budgets)
        let proposal = PoolRules(rules: [PermissionRule(tool: "Edit", pattern: nil)], note: "edits")
        XCTAssertEqual(vault.open(try vault.seal(proposal), as: PoolRules.self), proposal)
        let spend = vault.open(try vault.seal(["kind": "spend"]), as: PoolEventBody.self)
        XCTAssertEqual(spend?.kind, "spend")
        XCTAssertNil(spend?.costUSD)
    }
}
