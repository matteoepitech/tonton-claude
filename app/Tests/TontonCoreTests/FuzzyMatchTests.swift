import XCTest

@testable import TontonCore

final class FuzzyMatchTests: XCTestCase {
    func testCharactersInOrderAnywhere() {
        XCTAssertNotNil(FuzzyMatch.score("tcl", in: "tonton-claude"))
        XCTAssertNil(FuzzyMatch.score("clt", in: "tonton-claude"))
        XCTAssertEqual(FuzzyMatch.score("", in: "anything"), 0)
        XCTAssertNotNil(FuzzyMatch.score("API", in: "rate limit the api"))
    }

    func testWordStartsAndRunsRankFirst() {
        let items = ["infra-terraform", "api", "PC-Studio · api", "Settings › Machines"]
        XCTAssertEqual(FuzzyMatch.rank(items, query: "api") { $0 }.first, "api")
        XCTAssertEqual(FuzzyMatch.rank(items, query: "mach") { $0 }, ["Settings › Machines"])
        XCTAssertEqual(FuzzyMatch.rank(["web", "api"], query: "") { $0 }, ["web", "api"])
    }
}
