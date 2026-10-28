import XCTest

@testable import TontonCore

final class LimitForecastTableTests: XCTestCase {
    private struct Table: Decodable {
        struct Reading: Decodable {
            let at: String
            let usedPercent: Double
            let resetsAt: String
        }
        struct Case: Decodable {
            let name: String
            let readings: [Reading]
            let ask: Reading
            let runsOut: String?
        }
        let cases: [Case]
    }

    /// The same table as shared/test/limit-forecast.test.ts: the pool forecasts a session's window as the notch does.
    func testTheForecastIsTheClientCoresToo() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../shared/test/limit-forecast.json")
        let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
        let dates = ISO8601DateFormatter()
        func date(_ text: String) throws -> Date { try XCTUnwrap(dates.date(from: text), text) }
        XCTAssertGreaterThan(table.cases.count, 5)
        for item in table.cases {
            var forecast = LimitForecast()
            for reading in item.readings {
                forecast.record(
                    [UsageLimit(usedPercent: reading.usedPercent, resetsAt: try date(reading.resetsAt))], at: try date(reading.at))
            }
            let end = forecast.runsOut(
                UsageLimit(usedPercent: item.ask.usedPercent, resetsAt: try date(item.ask.resetsAt)), at: try date(item.ask.at))
            XCTAssertEqual(end.map { dates.string(from: $0) }, item.runsOut, item.name)
        }
    }
}
