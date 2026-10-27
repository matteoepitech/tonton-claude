import XCTest

@testable import TontonCore

/// TontonCore's text in French, from the compiled catalog: plurals, numbers and the sentences built from parts.
final class LocalizedTextTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    override func setUpWithError() throws { try Catalog.use("fr") }
    override func tearDown() { Catalog.reset() }

    func testPluralsUseTheOneFormForZeroToo() {
        XCTAssertEqual(Spoken.liveSessions(0), "Aucune session en cours")
        XCTAssertEqual(Spoken.liveSessions(1), "1 session en cours")
        XCTAssertEqual(Spoken.liveSessions(2), "2 sessions en cours")
        XCTAssertEqual(DailySummary.text(worked: 0, sessions: 1, cost: nil), "Aucune tâche terminée sur 1 session.")
    }

    func testAmountsAndDurationsAreWrittenTheFrenchWay() {
        XCTAssertEqual(Money.dollars(12.4), "12,40\u{A0}$")
        XCTAssertEqual(Money.dollars(50, digits: 0), "50\u{A0}$")
        XCTAssertEqual(UsageLimit.duration(from: now, to: now.addingTimeInterval(102 * 60)), "1 h 42")
        XCTAssertEqual(UsageLimit.duration(from: now, to: now.addingTimeInterval(53 * 3600)), "2 j 5 h")
        XCTAssertEqual(WrappedLog.duration(42 * 60), "42 min")
        XCTAssertEqual(TokenCounts.short(4_200), "4,2k")
        XCTAssertEqual(TokenCounts.short(5_000), "5k")
        XCTAssertEqual(TokenCounts.short(1_203_410), "1,2M")
    }

    func testSentencesKeepTheirOrder() {
        XCTAssertEqual(
            DailySummary.text(worked: 3 * 3600 + 20 * 60, sessions: 5, cost: 12.4), "3 h 20 de travail sur 5 sessions, 12,40\u{A0}$.")
        XCTAssertEqual(DailySummary.text(worked: 42 * 60, sessions: 0, cost: nil), "42 min de travail.")
        let limit = UsageLimit(usedPercent: 42.4, resetsAt: now.addingTimeInterval(3600))
        XCTAssertEqual(Spoken.status(.working, limit: limit, at: now), "Au travail, limite de 5 heures utilisée à 42\u{A0}%")
        XCTAssertEqual(SessionSummary.statusText("Claude needs your permission to use Bash", status: .permission), "Veut utiliser Bash")
        XCTAssertEqual(AgentText.localized("Conversation compacted"), "Conversation compactée")
        XCTAssertEqual(AgentText.localized("Something Claude wrote"), "Something Claude wrote")
    }
}
