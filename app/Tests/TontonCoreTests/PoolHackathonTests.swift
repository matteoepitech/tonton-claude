import XCTest

@testable import TontonCore

final class PoolHackathonTests: XCTestCase {
    private struct Table: Decodable {
        struct Case: Decodable {
            let ms: Double
            let label: String
        }
        let cases: [Case]
    }

    /// The same table as shared/test/pool-hackathon.test.ts: the notch counts down as the website does.
    func testTheCountdownReadsAsOnTheWebsite() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../shared/test/pool-countdown.json")
        let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(table.cases.count, 5)
        for item in table.cases { XCTAssertEqual(PoolHackathon.label(milliseconds: item.ms), item.label, "\(item.ms)") }
        let now = Date(timeIntervalSince1970: 1_793_095_200)  // 2026-10-27T10:00:00Z
        XCTAssertEqual(PoolHackathon.countdown("2026-10-27T12:05:00Z", now: now), "2 h 05 min left")
        XCTAssertEqual(PoolHackathon.countdown("2026-10-27T09:00:00.000Z", now: now), "Time is up")
        XCTAssertNil(PoolHackathon.countdown("soon", now: now))
        XCTAssertNil(PoolHackathon.countdown(nil, now: now))
        XCTAssertTrue(PoolHackathon.isLate("2026-10-27T10:10:00Z", now: now))
        XCTAssertFalse(PoolHackathon.isLate("2026-10-27T12:00:00Z", now: now))
    }

    func testTheInfoOfAHackathonReadsAsTheWebsiteSealsIt() throws {
        let json =
            #"{"name":"Basel Hack","goal":"A shop","template":"hackathon","deadline":"2026-10-28T10:00:00.000Z","startedAt":"2026-10-27T10:00:00.000Z","repo":"github.com/ana/shop"}"#
        let info = try JSONDecoder().decode(PoolInfo.self, from: Data(json.utf8))
        XCTAssertTrue(info.isHackathon)
        XCTAssertEqual(info.repo, "github.com/ana/shop")
        XCTAssertFalse(PoolInfo(name: "x").isHackathon)
    }

    func testASessionJoinsAsOneOfThePoolsRolesInOneStep() throws {
        let pool = try PoolVault(key: E2E.newKey())
        let notes = PoolNotes(
            text: "", sections: nil, areas: [PoolArea(name: "front", paths: []), PoolArea(name: "api", paths: ["server/"])])
        let snapshot = PoolSnapshot(
            id: "pool00000001", createdAt: "2026-10-27T09:00:00Z", paused: false, keyVersion: 1,
            info: try pool.seal(PoolInfo(name: "Hack")), members: [], sessions: [], tasks: [],
            notes: PoolItemWire(
                id: nil, rev: 1, seq: nil, updatedAt: "x", ts: nil, account: "ana", session: nil, blob: try pool.seal(notes)),
            messages: [], events: [], own: nil, orchestrator: nil)
        let state = PoolState(snapshot: snapshot, vault: pool)
        XCTAssertEqual(PoolHackathon.joinRoles(of: state), ["front", "api"])
        var bare = state
        bare.areas = []
        XCTAssertEqual(PoolHackathon.joinRoles(of: bare), ["front", "back", "infra", "qa"])
        XCTAssertEqual(PoolHackathon.roles.map(PoolHackathon.roleLabel), ["front", "back", "infra", "QA"])
    }
}
