import XCTest

@testable import TontonCore

final class WakeOnLANTests: XCTestCase {
    func testTheMagicPacket() throws {
        let packet = try XCTUnwrap(WakeOnLAN.magicPacket(mac: "a4:83:e7:01:02:03"))
        XCTAssertEqual(packet.count, 6 + 16 * 6)
        XCTAssertEqual(Array(packet.prefix(6)), [UInt8](repeating: 0xFF, count: 6))
        XCTAssertEqual(Array(packet[6..<12]), [0xA4, 0x83, 0xE7, 0x01, 0x02, 0x03])
        XCTAssertEqual(Array(packet.suffix(6)), [0xA4, 0x83, 0xE7, 0x01, 0x02, 0x03])
        XCTAssertEqual(WakeOnLAN.magicPacket(mac: "A4-83-E7-01-02-03"), packet)
    }

    func testNotAMACAddress() {
        XCTAssertNil(WakeOnLAN.magicPacket(mac: "a4:83:e7:01:02"))
        XCTAssertNil(WakeOnLAN.magicPacket(mac: "zz:83:e7:01:02:03"))
        XCTAssertNil(WakeOnLAN.magicPacket(mac: ""))
    }

    func testTheReportCarriesTheTargets() throws {
        let json =
            #"{"cpu":0,"memoryUsed":1,"memoryTotal":2,"battery":null,"wake":[{"mac":"a4:83:e7:01:02:03","broadcast":"192.168.1.255"}],"at":"x"}"#
        let health = try JSONDecoder().decode(MachineHealth.self, from: Data(json.utf8))
        XCTAssertEqual(health.wake, [WakeOnLAN.Target(mac: "a4:83:e7:01:02:03", broadcast: "192.168.1.255")])
        let older = #"{"cpu":0,"memoryUsed":1,"memoryTotal":2,"battery":null,"at":"x"}"#
        XCTAssertNil(try JSONDecoder().decode(MachineHealth.self, from: Data(older.utf8)).wake)
    }
}
