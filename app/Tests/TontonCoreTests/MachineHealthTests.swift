import XCTest

@testable import TontonCore

final class MachineHealthTests: XCTestCase {
    override func setUpWithError() throws { try Catalog.use("en") }
    override func tearDown() { Catalog.reset() }

    /// Sealed by agent/src/crypto.ts with the key of E2ETests (32 bytes set to 42), as the service sends it.
    private let agentKey = "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio"
    private let agentBlob =
        "ZnriLExpOYlLKYqAkOZGunJPRw1we2WrmYhGIkJp0UciVHSBkUKM1gZUquleWl+XqQNuZyZHkjUHzJEjIAjeFFma6PC1B1ZvMfyBM9mtRcteNmtv8IxVQqft3Zv2rGd/4KsUgq3cetoddn00/NB1uv86LCIMkKB9OZHcgRR2czqVaxRnvB0Fwo2htwD758yqi6skq0EeUtToIf9BlqA/bSFE7FpTlA=="

    func testTheAppOpensTheReportTheAgentSeals() throws {
        let vault = SessionVault(key: try E2E.key(fromBase64URL: agentKey))
        let machine = try XCTUnwrap(vault.machines([wire(health: agentBlob)]).first)
        let health = try XCTUnwrap(machine.health)
        XCTAssertEqual(health.cpu, 0.25)
        XCTAssertEqual(health.battery, MachineHealth.Battery(percent: 87, charging: true))
        XCTAssertEqual(health.summary, "CPU 25% · memory 11 / 16 GB · battery 87% ⚡")
    }

    func testOlderRelaysAndUnreadableReportsShowNothing() throws {
        let vault = SessionVault(key: try E2E.key(fromBase64URL: agentKey))
        XCTAssertNil(try XCTUnwrap(vault.machines([wire(health: nil)]).first).health)
        XCTAssertNil(try XCTUnwrap(vault.machines([wire(health: "not a blob")]).first).health)
        let json = #"{"id":"m1","name":"x","createdAt":"2026-10-26T12:00:00.000Z","lastSeen":null,"online":true,"agentVersion":null}"#
        XCTAssertNil(try JSONDecoder().decode(WireMachine.self, from: Data(json.utf8)).health)
    }

    func testAReportFromMinutesAgoIsStale() {
        let health = MachineHealth(cpu: 0, memoryUsed: 1, memoryTotal: 2, battery: nil, wake: nil, at: "2026-10-26T12:00:00.000Z")
        let at = Date(timeIntervalSince1970: 1_793_016_000)  // 2026-10-26T12:00:00Z
        XCTAssertFalse(health.isStale(now: at.addingTimeInterval(60)))
        XCTAssertTrue(health.isStale(now: at.addingTimeInterval(4 * 60)))
        XCTAssertEqual(health.summary, "CPU 0% · memory 0.0 / 0.0 GB")
    }

    private func wire(health: String?) throws -> WireMachine {
        var object: [String: Any] = ["id": "m1", "name": "", "createdAt": "2026-10-26T12:00:00.000Z", "online": true]
        if let health { object["health"] = health }
        return try JSONDecoder().decode(WireMachine.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
