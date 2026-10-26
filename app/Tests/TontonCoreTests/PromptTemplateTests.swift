import XCTest

@testable import TontonCore

final class PromptTemplateTests: XCTestCase {
    func testVariablesInOrderEachOnce() {
        let template = PromptTemplate(name: "Fix", text: "Fix issue #{number}: run `gh issue view {number}`, then ping {reviewer}")
        XCTAssertEqual(template.variables, ["number", "reviewer"])
        XCTAssertEqual(
            template.filled(["number": "42", "reviewer": "@del"]), "Fix issue #42: run `gh issue view 42`, then ping @del")
    }

    func testCodeAndJSONAreNotPlaceholders() {
        let template = PromptTemplate(name: "Body", text: #"Send {"a": 1} with fn() {} and if (a) { return b } to {project-name}"#)
        XCTAssertEqual(template.variables, ["project-name"])
        XCTAssertEqual(template.filled([:]), template.text)
        XCTAssertEqual(template.filled(["project-name": "tonton"]), #"Send {"a": 1} with fn() {} and if (a) { return b } to tonton"#)
    }

    func testAccentsAreFine() {
        XCTAssertEqual(PromptTemplate(name: "x", text: "Relis {fichier modifié}").variables, ["fichier modifié"])
    }
}
