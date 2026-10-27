import CryptoKit
import XCTest

@testable import TontonCore

final class DiagnosisTests: XCTestCase {
    /// Sealed by shared/crypto.ts with a key of 32 bytes set to 42, as `handleDiagnoseRequest` in the agent sends it.
    private let agentKey = "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio"
    private let agentDiagnosis =
        "pxmwwjj2PtOwid9c0CvqkH5DQQ92Idf2XQ617t/PCh6gRRn+Oh37nGOBZhr2naAM0SLNRF1Ew1jCUKZCoMx1Kc4yGvDf5s7YXJLi0RvuNBz7ZQhmP9Co6BMso7obLFmfy1J6iR0jlgg28oXIs6eRhbAqR40uooeTgZOnGg55K3Lxbeqcol9+mA3xEatTmcXgLozwCp0uyq0AJj0ihZdSsoo5mP1VQ/8YDuPfjBzCMosOUTIgpru+daWRjE7RcTQITO3iTHsGbJfkcTs+1lbCQ9AvQlgHRSm7iyp3nSMoyEbOusf4snB9Y68bMR9wshw+Ingv8m1bIEEEQMwnuWFN0hQKg94UKqQ8CGXoQFexg1tWHB+otfrYMuYCyHsTRtNbi3ckbhfrm29RLg8+otzAnImHVnjCWj72tbtWirs3CiBORAd54yylVlFKFcGKci+e7hg7uHa/eLiEy7XOV+GwhhaRBAmPc0hRbPYLOrx1ShJ3ZuRVViNSy0q37BnJ1mHgxl6Eh0fblHdtvG/MaA/r+N0cCQY+2D5wBPRokcWhUZbUCeC++r6aSuxehkorh1KwNDSBBvChxr9gFGAmUd4Iu+YMSmvis9c0NAnb22LM0T6WyMtHokUvx3TwVw=="

    func testOpensTheDiagnosisTheAgentSent() throws {
        let json = #"{"t":"diagnosis","machineId":"machine00001","requestId":"request0001","diagnosis":"\#(agentDiagnosis)"}"#
        guard
            case .diagnosis(let machineId, let requestId, let reason, let sealed) = try JSONDecoder().decode(
                RelayMessage.self, from: Data(json.utf8))
        else { return XCTFail("expected a diagnosis") }
        XCTAssertEqual([machineId, requestId], ["machine00001", "request0001"])
        XCTAssertNil(reason)
        let diagnosis = try XCTUnwrap(SessionVault(key: try E2E.key(fromBase64URL: agentKey)).diagnosis(sealed))
        XCTAssertEqual(diagnosis.version, "0.9.1")
        XCTAssertEqual(diagnosis.checks.map(\.id), ["agent", "hooks", "future"])
        XCTAssertEqual(
            diagnosis.failing,
            [Diagnosis.Check(id: "hooks", label: "Claude Code hooks", ok: false, detail: "Missing for Stop.", fix: "hooks")])
        XCTAssertEqual(
            diagnosis.fixed, Diagnosis.Repair(fix: "statusline", ok: true, text: "Status line set up for sessions started from now on."))
        XCTAssertEqual(diagnosis.checkedAt, ISO8601.parse("2026-10-27T10:00:00.000Z"))
    }

    func testTheRelaySaysWhenTheMachineIsOffline() throws {
        let json = #"{"t":"diagnosis","machineId":"m1","requestId":"request0001","reason":"offline"}"#
        guard case .diagnosis(_, _, let reason, let sealed) = try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8))
        else { return XCTFail("expected a diagnosis") }
        XCTAssertEqual(reason, "offline")
        XCTAssertNil(sealed)
    }

    func testTheRequestNamesItsMachineAndTheRepair() throws {
        let key = SymmetricKey(size: .bits256)
        let date = Date(timeIntervalSince1970: 1_792_497_600)
        let vault = SessionVault(key: key)
        let repair = try E2E.open(
            try vault.sealDiagnoseRequest(requestId: "request0001", machineId: "m1", fix: "hooks", issuedAt: date),
            as: DiagnoseRequest.self,
            with: key)
        XCTAssertEqual([repair.requestId, repair.machineId, repair.fix], ["request0001", "m1", "hooks"])
        XCTAssertEqual(ISO8601.parse(repair.issuedAt), date)
        // A plain check carries no `fix`, which older agents would not know.
        let check = try vault.sealDiagnoseRequest(requestId: "request0002", machineId: "m1")
        let plaintext = try XCTUnwrap(String(data: try E2E.plaintext(check, with: key), encoding: .utf8))
        XCTAssertFalse(plaintext.contains("fix"))
    }

    func testOnlyTheDiagnosisOfThisRequestAndMachineCounts() {
        let request = DiagnosisRequest(id: "request0001", machineId: "m1")
        let diagnosis = Diagnosis(requestId: "request0001", machineId: "m1", at: "x", version: "0.9.1", checks: [])
        XCTAssertEqual(request.received(reason: nil, answer: diagnosis, machine: "PC").state, .loaded(diagnosis))
        let other = Diagnosis(requestId: "request0001", machineId: "m2", at: "x", version: "0.9.1", checks: [])
        XCTAssertEqual(request.received(reason: nil, answer: other, machine: "PC"), request)
        let expired = Diagnosis(requestId: "request0001", machineId: "m1", at: "x", version: "0.9.1", checks: [], error: "Expired.")
        XCTAssertEqual(request.received(reason: nil, answer: expired, machine: "PC").state, .failed("Expired."))
        // The checks shown stay while the next ones come, after a repair too.
        let next = DiagnosisRequest(id: "request0002", machineId: "m1", previous: diagnosis)
        XCTAssertEqual(next.answer, diagnosis)
    }
}
