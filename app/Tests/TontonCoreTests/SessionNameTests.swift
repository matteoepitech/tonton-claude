import CryptoKit
import XCTest

@testable import TontonCore

final class SessionNameTests: XCTestCase {
    private let key = SymmetricKey(size: .bits256)
    private var vault: SessionVault { SessionVault(key: key) }

    private func session(_ id: String = "s1", name: String?) throws -> SessionSummary {
        let info = try E2E.seal(SessionInfo(machine: "PC", platform: nil, cwd: "/code/api", project: "api"), with: key)
        let json = """
            {"id":"\(id)","machineId":"m1","status":"idle","agentOnline":true,"canChat":true,"info":"\(info)","meta":null,
             "statusDetail":null,"pendingPermissions":[],"startedAt":"2026-10-27T10:00:00Z","lastActivity":"2026-10-27T10:00:00Z"
             \(name.map { #","name":"\#($0)""# } ?? "")}
            """
        return vault.session(try JSONDecoder().decode(WireSession.self, from: Data(json.utf8)), machines: [])
    }

    func testTheNameIsShownInsteadOfTheProject() throws {
        let renamed = try session(name: try vault.sealSessionName("  Billing rewrite ", for: "s1"))
        XCTAssertEqual(renamed.name, "Billing rewrite")
        XCTAssertEqual(renamed.displayName, "Billing rewrite")
        XCTAssertEqual(renamed.project, "api")
    }

    func testSessionsFromOlderRelaysOrNeverRenamedShowTheirProject() throws {
        let older = try session(name: nil)
        XCTAssertNil(older.name)
        XCTAssertEqual(older.displayName, "api")
        let json =
            #"{"t":"session","session":{"id":"s1","machineId":"m1","status":"idle","agentOnline":true,"canChat":true,"#
            + #""info":null,"meta":null,"statusDetail":null,"pendingPermissions":[],"startedAt":"x","lastActivity":"x","name":null}}"#
        guard case .session(let wire) = try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8)) else {
            return XCTFail("expected a session")
        }
        XCTAssertNil(vault.session(wire, machines: []).name)
    }

    func testAnEmptyNameBringsTheProjectBack() throws {
        XCTAssertEqual(try session(name: try vault.sealSessionName("   ", for: "s1")).displayName, "api")
    }

    func testANameTheRelayMovedFromAnotherSessionIsIgnored() throws {
        XCTAssertNil(try session("s2", name: try vault.sealSessionName("Billing rewrite", for: "s1")).name)
        let other = try E2E.seal(SessionName(sessionId: "s1", name: "Sealed elsewhere", issuedAt: "x"), with: SymmetricKey(size: .bits256))
        XCTAssertNil(try session(name: other).name)
    }

    func testTheNameIsSealedWithItsSession() throws {
        let date = Date(timeIntervalSince1970: 1_792_497_600)
        let opened = try E2E.open(try vault.sealSessionName("Billing", for: "s1", issuedAt: date), as: SessionName.self, with: key)
        XCTAssertEqual([opened.sessionId, opened.name], ["s1", "Billing"])
        XCTAssertEqual(ISO8601.parse(opened.issuedAt), date)
        // A few words: well under what the relay keeps.
        let long = try E2E.open(try vault.sealSessionName(String(repeating: "é", count: 500), for: "s1"), as: SessionName.self, with: key)
        XCTAssertEqual(long.name.count, SessionVault.maxSessionName)
    }

    func testScriptsAndTheSearchFindASessionByItsName() throws {
        let renamed = try session(name: try vault.sealSessionName("Billing rewrite", for: "s1"))
        XCTAssertEqual(try ScriptSessions.find("billing REWRITE", in: [renamed]).get().id, "s1")
        XCTAssertEqual(try ScriptSessions.find("api", in: [renamed]).get().id, "s1")
        XCTAssertTrue(renamed.matches("rewrite"))
        XCTAssertTrue(renamed.matches("api"))
    }
}
