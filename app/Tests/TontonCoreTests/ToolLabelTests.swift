import XCTest

@testable import TontonCore

final class ToolLabelTests: XCTestCase {
    private struct Table: Decodable {
        struct Case: Decodable {
            let name: String
            let label: String
        }
        let cases: [Case]
    }

    /// The same table as shared/test/tool-labels.test.ts: the island and the website name a tool as the notch does.
    func testAToolReadsAsTheWebAppShowsIt() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../shared/test/tool-labels.json")
        let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(table.cases.count, 5)
        for item in table.cases { XCTAssertEqual(ToolLabel.text(item.name), item.label, item.name) }
    }

    func testAnMCPToolIsItsServerAndTheRestOfItsName() {
        XCTAssertEqual(ToolLabel.mcp("mcp__srv__a__b")?.server, "srv")
        XCTAssertEqual(ToolLabel.mcp("mcp__srv__a__b")?.tool, "a__b")
        for name in ["mcp__x", "mcp____y", "mcp__srv__", "Bash", "unreal-engine_spawn_actor", ""] {
            XCTAssertNil(ToolLabel.mcp(name), name)
        }
    }

    func testVoiceOverReadsWordsNotUnderscores() {
        XCTAssertEqual(ToolLabel.spoken("mcp__unreal-engine__spawn_actor"), "unreal-engine, spawn actor")
        XCTAssertEqual(ToolLabel.spoken("mcp__srv__a__b"), "srv, a b")
        XCTAssertEqual(ToolLabel.spoken("Bash"), "Bash")
        XCTAssertEqual(ToolLabel.spoken("mcp__x"), "mcp__x")
    }

    func testTheAlertOfAnMCPToolNamesItsServerAndTool() {
        let request = PermissionRequest(
            requestId: "r1", toolName: "mcp__unreal-engine__spawn_actor", description: "", inputPreview: "", ts: "")
        XCTAssertEqual(SessionVault.alertBody(request), "Allow unreal-engine · spawn_actor?")
    }
}
