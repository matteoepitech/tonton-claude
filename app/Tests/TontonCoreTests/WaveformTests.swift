import XCTest

@testable import TontonCore

final class WaveformTests: XCTestCase {
    func testTheWaveJumpsWithAnEntryAndSettlesBack() {
        let times = stride(from: 0.0, through: 10, by: 0.37)
        let fresh = times.map { Waveform.levels(time: $0, sinceEntry: 0) }
        let calm = times.map { Waveform.levels(time: $0, sinceEntry: 30) }
        for levels in fresh + calm {
            XCTAssertEqual(levels.count, Waveform.bars)
            XCTAssertTrue(levels.allSatisfy { (0...1).contains($0) })
        }
        XCTAssertGreaterThan(fresh.flatMap { $0 }.max() ?? 0, 0.8)
        XCTAssertLessThanOrEqual(calm.flatMap { $0 }.max() ?? 1, 0.36)
    }

    func testWithoutMotionTheWaveStaysStill() {
        XCTAssertEqual(Waveform.levels(time: 0, sinceEntry: 0, moving: false), Waveform.levels(time: 3, sinceEntry: 9, moving: false))
    }
}
