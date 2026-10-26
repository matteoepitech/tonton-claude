import CryptoKit
import XCTest

@testable import TontonCore

final class AgentLogsTests: XCTestCase {
    /// Sealed by agent/src/crypto.ts with a key of 32 bytes set to 42, as `handleLogRequest` sends it.
    private let agentKey = "KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio"
    private let agentLog =
        "ljdOTKIB0ubNssfqrJZifMEj6rzICfw72xvwH6cNlpCUTIX45yoPRP3v7015nsuN1qI9QOuWs+eRyBwW1EPjSRa8CSMDE8dQjuM1us36K1qQ4FD1zajBETZjngmru9nx84gJ7tojn9MaAHsxFAfp8WcXj45m63DTg17eaHAL6mbWTIO57DXLDf0naCdRRLbwpExJuXWuMpx1HUcbPYGvLXvRaWcLxQ/NPHV8DLia2wKJJJsJb0L8ju7lMEkX2VRmAYTYYsgWsPTatfo7MVrD8RN7i6uRSVby4yZdppVt6wdcBBPSIqrQzXzvSCphfCgkSKkj/EF/SAbXisEpj72xNF04hAqjriyc5OIRSWVhT9cqhdfc3G6wjAm6wQ=="

    private func vault() throws -> SessionVault { SessionVault(key: try E2E.key(fromBase64URL: agentKey)) }

    func testOpensTheLogTheAgentSent() throws {
        let json = #"{"t":"agent_logs","machineId":"machine00001","requestId":"request0001","logs":"\#(agentLog)"}"#
        guard
            case .agentLogs(let machineId, let requestId, let reason, let logs) = try JSONDecoder().decode(
                RelayMessage.self, from: Data(json.utf8))
        else { return XCTFail("expected agent_logs") }
        XCTAssertEqual(machineId, "machine00001")
        XCTAssertEqual(requestId, "request0001")
        XCTAssertNil(reason)
        let log = try XCTUnwrap(try vault().agentLog(logs))
        XCTAssertEqual(log.lines.count, 2)
        XCTAssertTrue(log.truncated)
        XCTAssertEqual(log.size, 20480)
        XCTAssertNil(log.error)
        XCTAssertEqual(log.readAt, ISO8601.parse("2026-10-26T12:00:00.000Z"))
    }

    func testTheRelaySaysWhenTheMachineIsOffline() throws {
        let json = #"{"t":"agent_logs","machineId":"m1","requestId":"request0001","reason":"offline"}"#
        guard case .agentLogs(_, _, let reason, let logs) = try JSONDecoder().decode(RelayMessage.self, from: Data(json.utf8))
        else { return XCTFail("expected agent_logs") }
        XCTAssertEqual(reason, "offline")
        XCTAssertNil(logs)
    }

    func testTheRequestNamesItsMachineAndDate() throws {
        let key = SymmetricKey(size: .bits256)
        let date = Date(timeIntervalSince1970: 1_792_497_600)
        let sealed = try SessionVault(key: key).sealLogRequest(requestId: "request0001", machineId: "m1", issuedAt: date)
        let request = try E2E.open(sealed, as: LogRequest.self, with: key)
        XCTAssertEqual(request.requestId, "request0001")
        XCTAssertEqual(request.machineId, "m1")
        XCTAssertEqual(ISO8601.parse(request.issuedAt), date)
    }

    func testOnlyTheLogOfThisRequestAndMachineCounts() {
        let request = AgentLogRequest(id: "request0001", machineId: "m1")
        let log = AgentLog(requestId: "request0001", machineId: "m1", lines: ["a"], at: "2026-10-26T12:00:00Z")
        XCTAssertEqual(request.received(reason: nil, log: log, machine: "PC").state, .loaded(log))
        // An older log, another machine's, or one that does not open.
        let older = AgentLog(requestId: "request0000", machineId: "m1", lines: ["old"], at: "x")
        let other = AgentLog(requestId: "request0001", machineId: "m2", lines: ["other"], at: "x")
        for answer in [older, other, nil] { XCTAssertEqual(request.received(reason: nil, log: answer, machine: "PC"), request) }
        // Once answered, a second answer changes nothing.
        let loaded = request.received(reason: nil, log: log, machine: "PC")
        XCTAssertEqual(loaded.received(reason: "offline", log: nil, machine: "PC"), loaded)
    }

    func testFailuresSayWhy() {
        let request = AgentLogRequest(id: "request0001", machineId: "m1")
        XCTAssertEqual(
            request.received(reason: "offline", log: nil, machine: "PC").state,
            .failed("PC is offline. Check that it is on and that the Tonton Claude agent runs there."))
        let expired = AgentLog(requestId: "request0001", machineId: "m1", lines: [], at: "x", error: "The request expired.")
        XCTAssertEqual(request.received(reason: nil, log: expired, machine: "PC").state, .failed("The request expired."))
    }

    func testTheLogShownStaysWhileTheNextOneLoads() {
        let log = AgentLog(requestId: "request0001", machineId: "m1", lines: ["a"], at: "x")
        let next = AgentLogRequest(id: "request0002", machineId: "m1", previous: log)
        XCTAssertTrue(next.isLoading)
        XCTAssertEqual(next.log, log)
        XCTAssertEqual(next.failed("No answer").log, log)
        let newer = AgentLog(requestId: "request0002", machineId: "m1", lines: ["b"], at: "x")
        XCTAssertEqual(next.received(reason: nil, log: newer, machine: "PC").log, newer)
    }

    func testLinesSplitIntoTimeAndMessage() {
        let line = AgentLogLine(#"2026-10-26T11:59:00.000Z [42] service started {"version":"0.5.0"}"#)
        XCTAssertEqual(line.date, ISO8601.parse("2026-10-26T11:59:00.000Z"))
        XCTAssertEqual(line.pid, 42)
        XCTAssertEqual(line.message, #"service started {"version":"0.5.0"}"#)
        for raw in ["Traceback from the tray", "2026-13-99 [x] nope", ""] {
            XCTAssertEqual(AgentLogLine(raw), AgentLogLine(raw))
            XCTAssertNil(AgentLogLine(raw).date)
            XCTAssertEqual(AgentLogLine(raw).message, raw)
        }
    }
}
