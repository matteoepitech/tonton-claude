import XCTest

@testable import TontonMac

final class LocalAgentTests: XCTestCase {
    private func config(_ json: String) -> Data { Data(json.utf8) }

    func testTheMachineIdOfAnAgentOnTheSameAccount() {
        let data = config(#"{"server":"https://r","account":"acc","machineId":"m1","token":"tm_x","key":"k","machine":"mac"}"#)
        XCTAssertEqual(LocalAgent.machineId(from: data, for: "acc"), "m1")
    }

    func testAnAgentOnAnotherAccountIsNotThisMac() {
        XCTAssertNil(LocalAgent.machineId(from: config(#"{"account":"other","machineId":"m1"}"#), for: "acc"))
    }

    func testConfigsWithoutAnAccountStillCount() {
        XCTAssertEqual(LocalAgent.machineId(from: config(#"{"machineId":"m1"}"#), for: "acc"), "m1")
    }

    func testBrokenConfigs() {
        XCTAssertNil(LocalAgent.machineId(from: config("not json"), for: "acc"))
        XCTAssertNil(LocalAgent.machineId(from: config(#"{"machineId":""}"#), for: "acc"))
        XCTAssertNil(LocalAgent.machineId(from: config(#"{"server":"https://r"}"#), for: "acc"))
    }
}
