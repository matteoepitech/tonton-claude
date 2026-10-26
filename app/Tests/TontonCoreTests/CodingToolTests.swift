import CryptoKit
import XCTest

@testable import TontonCore

final class CodingToolTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_005_200)

    private func session(_ id: String, tool: String? = nil, project: String = "api", cost: Double? = nil) -> SessionSummary {
        SessionSummary(
            id: id, machineId: "m", machine: "PC", platform: nil, cwd: "/x", project: project, title: "Fix the login", status: .working,
            statusText: nil, agentOnline: true, canChat: true, pendingPermissions: [], costUSD: cost, startedAt: now, lastActivity: now,
            lastMessage: nil, tool: tool)
    }

    func testOlderAgentsAndUnknownToolsAreClaudeCode() {
        XCTAssertEqual(CodingTool(nil), .claudeCode)
        XCTAssertEqual(CodingTool("opencode"), .openCode)
        XCTAssertEqual(CodingTool("aider"), .claudeCode)
        XCTAssertEqual(session("s", tool: "opencode").codingTool.label, "OpenCode")
    }

    func testTheSearchFindsSessionsByTool() {
        XCTAssertTrue(session("s", tool: "opencode").matches("opencode"))
        XCTAssertTrue(session("s").matches("claude"))
        XCTAssertFalse(session("s").matches("opencode"))
        XCTAssertTrue(session("s").matches("login"))
        XCTAssertTrue(session("s").matches(""))
    }

    func testRowsShowTheToolOnlyWhenBothAreListed() {
        XCTAssertFalse([session("a"), session("b")].mixesTools)
        XCTAssertTrue([session("a"), session("b", tool: "opencode")].mixesTools)
    }

    func testUsageIsKeptAndTotalledPerTool() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Paris") ?? .current
        var history = UsageHistory()
        // The same project on the same machine, with both tools.
        history.record([session("a", cost: 1.0), session("b", tool: "opencode", cost: 0.25)], at: now, calendar: calendar)
        XCTAssertEqual(history.entries.count, 2)
        let tools = history.totals(by: \.toolName, days: 1, until: now, calendar: calendar)
        XCTAssertEqual(tools.map(\.name), ["Claude Code", "OpenCode"])
        XCTAssertEqual(tools.map(\.costUSD), [1.0, 0.25])
        // usage.json from before this version has no tool: it counts as Claude Code.
        let old =
            #"{"entries":[{"day":"2026-10-25","machine":"PC","project":"api","costUSD":2,"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}],"readings":{}}"#
        let decoded = try JSONDecoder().decode(UsageHistory.self, from: Data(old.utf8))
        XCTAssertEqual(decoded.entries.first?.toolName, "Claude Code")
    }

    private func machine(tools: [String]?) throws -> MachineInfo {
        let toolsJSON = tools.map { ",\"tools\":[\($0.map { "\"\($0)\"" }.joined(separator: ","))]" } ?? ""
        let json = #"{"cpu":0.2,"memoryUsed":1,"memoryTotal":2,"battery":null"# + toolsJSON + #","at":"2026-10-26T10:00:00Z"}"#
        let health = try JSONDecoder().decode(MachineHealth.self, from: Data(json.utf8))
        return MachineInfo(
            id: "m", name: "PC", platform: "linux", createdAt: now, lastSeen: now, online: true, agentVersion: "0.7.0", health: health)
    }

    func testTheNotchOnlyOffersOpenCodeToAgentsThatListIt() throws {
        XCTAssertEqual(try machine(tools: nil).startableTools, [.claudeCode])
        XCTAssertEqual(try machine(tools: ["claude", "opencode"]).startableTools, [.claudeCode, .openCode])
        XCTAssertEqual(try machine(tools: ["opencode"]).startableTools, [.openCode])
        // Nothing found on the PATH of the service: claude is still worth a try.
        XCTAssertEqual(try machine(tools: []).startableTools, [.claudeCode])
        XCTAssertEqual(try machine(tools: ["aider"]).startableTools, [.claudeCode])
    }

    func testStartOrdersNameOpenCodeAndLeaveClaudeAsOlderAgentsKnowIt() throws {
        let key = SymmetricKey(size: .bits256)
        let vault = SessionVault(key: key)
        let claude = try E2E.open(
            try vault.sealStartOrder(launchId: "l1", machineId: "m", cwd: "~/api"), as: [String: String].self, with: key)
        XCTAssertNil(claude["tool"])
        let opencode = try E2E.open(
            try vault.sealStartOrder(launchId: "l1", machineId: "m", cwd: "~/api", tool: .openCode), as: [String: String].self, with: key)
        XCTAssertEqual(opencode["tool"], "opencode")
        let launch = SessionLaunch(id: "l1", machineId: "m", cwd: "~/api", tool: .openCode)
        XCTAssertEqual(launch.failed("no").tool, .openCode)
        XCTAssertEqual(launch.answered("q").tool, .openCode)
    }
}
