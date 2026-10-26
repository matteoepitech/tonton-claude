import AppKit
import XCTest

@testable import TontonCore

final class SoundsTests: XCTestCase {
    func testEachAlertHasItsEvent() {
        XCTAssertEqual(SoundEvent.of(.idle, finished: true), .finished)
        XCTAssertEqual(SoundEvent.of(.permission, finished: false), .permission)
        XCTAssertEqual(SoundEvent.of(.waiting, finished: false), .question)
        XCTAssertEqual(SoundEvent.of(.error, finished: false), .error)
    }

    func testEveryPackHasASoundForEveryEvent() {
        for event in SoundEvent.allCases {
            XCTAssertNotNil(ChipSound.named(SoundPack.eightBit.sound(for: event)))
            XCTAssertNil(ChipSound.named(SoundPack.macOS.sound(for: event)))
        }
        XCTAssertEqual(Set(ChipSound.allCases.map(\.id)).count, ChipSound.allCases.count)
    }

    func testChiptunesAreWAVFilesMacOSCanPlay() throws {
        for sound in ChipSound.allCases {
            let wav = sound.wav
            XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
            XCTAssertEqual(String(decoding: wav[8..<12], as: UTF8.self), "WAVE")
            let duration = sound.notes.map(\.duration).reduce(0, +)
            XCTAssertEqual(Double(wav.count - 44), duration * 22_050, accuracy: Double(sound.notes.count))
            let player = try XCTUnwrap(NSSound(data: wav), "\(sound) does not decode")
            XCTAssertEqual(player.duration, duration, accuracy: 0.01)
        }
    }
}
