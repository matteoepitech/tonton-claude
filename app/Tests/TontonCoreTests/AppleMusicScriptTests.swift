import Foundation
import XCTest

@testable import TontonCore

/// What Music's AppleScript and its notification say, from fixtures: no test sends Music anything.
final class AppleMusicScriptTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_000)

    /// A line as `readScript` writes it.
    private func line(_ fields: String...) -> String { fields.joined(separator: "\u{1F}") }

    func testAPlayingTrack() throws {
        let output = line(
            "playing", "72", "83250", "true", "all", "8F1A2B3C4D5E6F70", "Never Gonna Give You Up", "Rick Astley",
            "Whenever You Need Somebody", "213573")
        let reading = try XCTUnwrap(AppleMusic.reading(from: output))
        XCTAssertEqual(reading.state, .playing)
        XCTAssertEqual(reading.volume, 72)
        XCTAssertEqual(reading.shuffling, true)
        XCTAssertEqual(reading.repeating, true)
        let now = try XCTUnwrap(reading.nowPlaying(at: date))
        XCTAssertEqual(now.app, "com.apple.Music")
        XCTAssertEqual(now.title, "Never Gonna Give You Up")
        XCTAssertEqual(now.artist, "Rick Astley")
        XCTAssertEqual(now.album, "Whenever You Need Somebody")
        XCTAssertTrue(now.isPlaying)
        XCTAssertEqual(try XCTUnwrap(now.duration), 213.573, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(now.position), 83.25, accuracy: 0.0001)
        XCTAssertEqual(now.positionDate, date)
        XCTAssertEqual(now.trackId, "8F1A2B3C4D5E6F70")
        // Music gives the cover's bytes, not an address.
        XCTAssertNil(now.artworkURL)
        XCTAssertEqual(now.volume, 72)
    }

    func testPausedIsNotPlaying() throws {
        let output = line("paused", "100", "0", "false", "off", "0000000000000ABC", "Song", "Artist", "Album", "200000")
        let now = try XCTUnwrap(AppleMusic.reading(from: output)?.nowPlaying(at: date))
        XCTAssertFalse(now.isPlaying)
        XCTAssertEqual(now.position, 0)
        XCTAssertEqual(now.shuffling, false)
        XCTAssertEqual(now.repeating, false)
    }

    func testWindingForwardOrBackStillPlays() throws {
        for state in ["fast forwarding", "rewinding"] {
            let output = line(state, "50", "1000", "false", "one", "0000000000000ABC", "Song", "Artist", "Album", "200000")
            let reading = try XCTUnwrap(AppleMusic.reading(from: output), state)
            XCTAssertTrue(reading.isPlaying, state)
            XCTAssertEqual(reading.repeating, true)
            XCTAssertEqual(reading.nowPlaying(at: date)?.isPlaying, true, state)
        }
    }

    func testStoppedShowsNothing() throws {
        let reading = try XCTUnwrap(AppleMusic.reading(from: line("stopped", "50", "", "false", "off")))
        XCTAssertEqual(reading.state, .stopped)
        XCTAssertNil(reading.track)
        XCTAssertNil(reading.position)
        XCTAssertNil(reading.nowPlaying(at: date))
        // Stopped with a track still selected: nothing either.
        let selected = line("stopped", "50", "0", "false", "off", "0000000000000ABC", "Song", "Artist", "Album", "200000")
        XCTAssertNil(AppleMusic.reading(from: selected)?.nowPlaying(at: date))
    }

    func testPausedWithNoTrack() throws {
        let reading = try XCTUnwrap(AppleMusic.reading(from: line("paused", "50", "", "false", "off")))
        XCTAssertNil(reading.track)
        XCTAssertNil(reading.nowPlaying(at: date))
    }

    func testAStreamWithNoLengthAndMissingValues() throws {
        let output = line("playing", "50", "12000", "false", "off", "1234ABCD", "Radio", "missing value", "missing value", "")
        let now = try XCTUnwrap(AppleMusic.reading(from: output)?.nowPlaying(at: date))
        XCTAssertEqual(now.title, "Radio")
        XCTAssertEqual(now.artist, "")
        XCTAssertEqual(now.album, "")
        XCTAssertNil(now.duration)
        // Padded to the 16 digits AppleScript writes.
        XCTAssertEqual(now.trackId, "000000001234ABCD")
    }

    func testADecimalComma() throws {
        let output = line("playing", "50", "1500,5", "false", "off", "0000000000000ABC", "Song", "Artist", "Album", "180000,0")
        let now = try XCTUnwrap(AppleMusic.reading(from: output)?.nowPlaying(at: date))
        XCTAssertEqual(try XCTUnwrap(now.position), 1.5005, accuracy: 0.0001)
        XCTAssertEqual(now.duration, 180)
    }

    func testWhatIsNotAReading() {
        XCTAssertNil(AppleMusic.reading(from: ""))
        XCTAssertNil(AppleMusic.reading(from: "ok"))
        XCTAssertNil(AppleMusic.reading(from: line("dancing", "50", "0", "false", "off")))
        XCTAssertNil(AppleMusic.reading(from: line("playing", "50")))
        // A reading with an id that isn't hexadecimal keeps the track, without the id.
        let odd = line("playing", "50", "0", "false", "off", "not-an-id", "Song", "Artist", "Album", "1000")
        XCTAssertNil(AppleMusic.reading(from: odd)?.track?.id)
        XCTAssertEqual(AppleMusic.reading(from: odd)?.track?.name, "Song")
    }

    // MARK: The notification

    func testTheNotification() throws {
        let reading = try XCTUnwrap(
            AppleMusic.reading(fromNotification: [
                "Player State": "Playing", "Name": "Song", "Artist": "Artist", "Album": "Album", "Total Time": 213_573,
                "PersistentID": NSNumber(value: Int64(-8_134_567_890_123_456_789)), "Genre": "Pop",
            ]))
        XCTAssertEqual(reading.state, .playing)
        XCTAssertNil(reading.position)
        XCTAssertNil(reading.volume)
        let track = try XCTUnwrap(reading.track)
        XCTAssertEqual(track.name, "Song")
        XCTAssertEqual(try XCTUnwrap(track.duration), 213.573, accuracy: 0.0001)
        // The bits of the signed number, as AppleScript's `persistent ID` writes them.
        XCTAssertEqual(track.id, String(format: "%016llX", UInt64(bitPattern: -8_134_567_890_123_456_789)))
        XCTAssertEqual(track.id, "8F1C359A4BE47EEB")
    }

    func testTheNotificationWhenItPausesOrStops() throws {
        let paused = try XCTUnwrap(AppleMusic.reading(fromNotification: ["Player State": "Paused", "Name": "Song", "PersistentID": 42]))
        XCTAssertEqual(paused.state, .paused)
        XCTAssertEqual(paused.track?.id, "000000000000002A")
        XCTAssertEqual(paused.nowPlaying(at: date)?.isPlaying, false)
        let stopped = try XCTUnwrap(AppleMusic.reading(fromNotification: ["Player State": "Stopped"]))
        XCTAssertNil(stopped.track)
        XCTAssertNil(stopped.nowPlaying(at: date))
        XCTAssertNil(AppleMusic.reading(fromNotification: [:]))
        XCTAssertNil(AppleMusic.reading(fromNotification: ["Player State": 1]))
        XCTAssertNil(AppleMusic.reading(fromNotification: ["Name": "Song"]))
    }

    func testTheIdAsText() {
        XCTAssertEqual(AppleMusic.trackId("8f1c0d8e7a0b4ceb"), "8F1C0D8E7A0B4CEB")
        XCTAssertEqual(AppleMusic.trackId(" 2A "), "000000000000002A")
        XCTAssertNil(AppleMusic.trackId("8F1C0D8E7A0B4CEB0"))
        XCTAssertNil(AppleMusic.trackId("12\" & quit"))
        XCTAssertNil(AppleMusic.trackId("１２"))
        XCTAssertNil(AppleMusic.trackId(nil))
    }

    func testANotificationKeepsWhereTheTrackWas() throws {
        let read = try XCTUnwrap(
            AppleMusic.reading(
                from: line("playing", "64", "30000", "false", "off", "0000000000000ABC", "Song", "Artist", "Album", "200000"))?
                .nowPlaying(at: date))
        let paused = try XCTUnwrap(
            AppleMusic.reading(fromNotification: ["Player State": "Paused", "Name": "Song", "PersistentID": 0xABC, "Total Time": 200_000]))
        // Paused 12 seconds later: at 42 seconds, with the volume of the read.
        let now = try XCTUnwrap(paused.nowPlaying(at: date.addingTimeInterval(12), after: read))
        XCTAssertFalse(now.isPlaying)
        XCTAssertEqual(try XCTUnwrap(now.position), 42, accuracy: 0.0001)
        XCTAssertEqual(now.volume, 64)
        // Another track starts with no position until the read that follows.
        let next = try XCTUnwrap(
            AppleMusic.reading(fromNotification: ["Player State": "Playing", "Name": "Next", "PersistentID": 0xDEF])?
                .nowPlaying(at: date.addingTimeInterval(12), after: read))
        XCTAssertNil(next.position)
        XCTAssertEqual(next.volume, 64)
        // Another player's track says nothing of this one.
        let spotify = NowPlaying(
            app: Spotify.bundleId, title: "Song", artist: "", album: "", isPlaying: true, position: 99, trackId: "0000000000000ABC")
        XCTAssertNil(paused.nowPlaying(at: date, after: spotify)?.position)
    }

    func testTheSecondOfTwoNotificationsIsARepeat() throws {
        let reading = try XCTUnwrap(AppleMusic.reading(fromNotification: ["Player State": "Playing", "Name": "Song", "PersistentID": 1]))
        let other = try XCTUnwrap(AppleMusic.reading(fromNotification: ["Player State": "Paused", "Name": "Song", "PersistentID": 1]))
        XCTAssertFalse(AppleMusic.repeats(reading, at: date, last: nil, receivedAt: nil))
        XCTAssertTrue(AppleMusic.repeats(reading, at: date.addingTimeInterval(0.05), last: reading, receivedAt: date))
        XCTAssertFalse(AppleMusic.repeats(other, at: date.addingTimeInterval(0.05), last: reading, receivedAt: date))
        // The same again later is a change: played, paused and played again.
        XCTAssertFalse(AppleMusic.repeats(reading, at: date.addingTimeInterval(2), last: reading, receivedAt: date))
    }

    // MARK: The scripts

    func testEveryScriptChecksThatMusicRunsAndHasATimeout() throws {
        let commands: [MusicCommand] = [.playPause, .nextTrack, .previousTrack, .seek(10), .volume(50)]
        let scripts =
            [AppleMusic.readScript, try XCTUnwrap(AppleMusic.artworkScript(for: "0000000000000ABC"))]
            + commands.map(AppleMusic.script(for:))
        for script in scripts {
            XCTAssertTrue(script.hasPrefix(#"if application id "com.apple.Music" is not running then return """#), script)
            XCTAssertTrue(script.contains("with timeout of"), script)
            XCTAssertFalse(script.contains(#"tell application "Music""#), script)
        }
    }

    func testTheCommands() {
        XCTAssertTrue(AppleMusic.script(for: .playPause).contains(#"tell application id "com.apple.Music" to playpause"#))
        XCTAssertTrue(AppleMusic.script(for: .nextTrack).contains("to next track"))
        // As Music's own button.
        XCTAssertTrue(AppleMusic.script(for: .previousTrack).contains("to back track"))
        XCTAssertTrue(AppleMusic.script(for: .volume(140)).contains("set sound volume to 100"))
        XCTAssertTrue(AppleMusic.script(for: .volume(-3)).contains("set sound volume to 0"))
        XCTAssertTrue(AppleMusic.script(for: .seek(-5)).contains("set player position to 0.000"))
        XCTAssertTrue(AppleMusic.script(for: .seek(.nan)).contains("set player position to 0.000"))
    }

    func testASeekKeepsItsPointInFrench() {
        let locale = Strings.locale
        defer { Strings.locale = locale }
        Strings.locale = Locale(identifier: "fr_FR")
        XCTAssertTrue(AppleMusic.script(for: .seek(83.25)).contains("set player position to 83.250"))
    }

    func testTheArtworkScriptOnlyTakesAnId() throws {
        let script = try XCTUnwrap(AppleMusic.artworkScript(for: "8f1c0d8e7a0b4ceb"))
        XCTAssertTrue(script.contains(#"if (persistent ID of t) is not "8F1C0D8E7A0B4CEB" then return """#))
        XCTAssertTrue(script.contains("return data of artwork 1 of t"))
        XCTAssertNil(AppleMusic.artworkScript(for: #"ABC" then do shell script "true"#))
        XCTAssertNil(AppleMusic.artworkScript(for: ""))
    }
}
