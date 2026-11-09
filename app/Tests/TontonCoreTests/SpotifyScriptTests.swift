import Foundation
import XCTest

@testable import TontonCore

/// What Spotify's AppleScript and its notification say, from fixtures: no test sends Spotify anything.
final class SpotifyScriptTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_000)
    private let cover = "https://i.scdn.co/image/ab67616d0000b273d9194aa18fa4c9362b47464f"

    /// A line as `readScript` writes it.
    private func line(_ fields: String...) -> String { fields.joined(separator: "\u{1F}") }

    func testAPlayingTrack() throws {
        let output = line(
            "playing", "64", "83250", "true", "false", "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "Never Gonna Give You Up",
            "Rick Astley", "Whenever You Need Somebody", "213573", cover)
        let reading = try XCTUnwrap(Spotify.reading(from: output))
        XCTAssertEqual(reading.state, .playing)
        XCTAssertEqual(reading.volume, 64)
        XCTAssertEqual(reading.shuffling, true)
        XCTAssertEqual(reading.repeating, false)
        let now = try XCTUnwrap(reading.nowPlaying(at: date))
        XCTAssertEqual(now.app, "com.spotify.client")
        XCTAssertEqual(now.title, "Never Gonna Give You Up")
        XCTAssertEqual(now.artist, "Rick Astley")
        XCTAssertEqual(now.album, "Whenever You Need Somebody")
        XCTAssertTrue(now.isPlaying)
        // Spotify gives milliseconds for both, whatever its dictionary says of the duration.
        XCTAssertEqual(try XCTUnwrap(now.duration), 213.573, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(now.position), 83.25, accuracy: 0.0001)
        XCTAssertEqual(now.positionDate, date)
        XCTAssertEqual(now.trackId, "spotify:track:4uLU6hMCjMI75M1A2tKUQC")
        XCTAssertEqual(now.artworkURL?.absoluteString, cover)
        XCTAssertEqual(now.volume, 64)
    }

    func testPausedIsNotPlaying() throws {
        let output = line("paused", "100", "0", "false", "true", "spotify:track:x", "Song", "Artist", "Album", "200000", cover)
        let now = try XCTUnwrap(Spotify.reading(from: output)?.nowPlaying(at: date))
        XCTAssertFalse(now.isPlaying)
        XCTAssertEqual(now.position, 0)
        XCTAssertEqual(now.repeating, true)
    }

    func testStoppedShowsNothing() throws {
        let reading = try XCTUnwrap(Spotify.reading(from: line("stopped", "50", "0", "false", "false")))
        XCTAssertEqual(reading.state, .stopped)
        XCTAssertNil(reading.track)
        XCTAssertNil(reading.nowPlaying(at: date))
        // Stopped with a track still loaded shows nothing either.
        let loaded = line("stopped", "50", "0", "false", "false", "spotify:track:x", "Song", "Artist", "Album", "1000", cover)
        XCTAssertNil(Spotify.reading(from: loaded)?.nowPlaying(at: date))
    }

    /// Just opened, Spotify can be paused without a track: the script leaves the track's fields out.
    func testNoTrackYet() throws {
        let reading = try XCTUnwrap(Spotify.reading(from: line("paused", "50", "", "false", "false")))
        XCTAssertNil(reading.position)
        XCTAssertNil(reading.nowPlaying(at: date))
    }

    /// A file of the user's own has no cover; AppleScript writes "missing value" for it.
    func testALocalFile() throws {
        let output = line(
            "playing", "50", "1000", "false", "false", "spotify:local:a:b:c:200", "Demo", "missing value", "", "200000", "missing value")
        let now = try XCTUnwrap(Spotify.reading(from: output)?.nowPlaying(at: date))
        XCTAssertEqual(now.title, "Demo")
        XCTAssertEqual(now.artist, "")
        XCTAssertNil(now.artworkURL)
        XCTAssertEqual(now.duration, 200)
    }

    func testAnAdWithoutADuration() throws {
        let output = line("playing", "50", "1000", "false", "false", "spotify:ad:000000012c603a6600000020316a17a1", "", "", "", "0", "")
        let now = try XCTUnwrap(Spotify.reading(from: output)?.nowPlaying(at: date))
        XCTAssertNil(now.duration)
        XCTAssertNil(now.artworkURL)
    }

    /// A position written with a decimal comma, should a script ever send a real number.
    func testADecimalComma() throws {
        let reading = try XCTUnwrap(Spotify.reading(from: line("playing", "50", "1500,5", "false", "false")))
        XCTAssertEqual(try XCTUnwrap(reading.position), 1.5005, accuracy: 0.00001)
    }

    /// Empty when Spotify doesn't run; anything else unknown is no reading either.
    func testWhatIsNoReading() {
        XCTAssertNil(Spotify.reading(from: ""))
        XCTAssertNil(Spotify.reading(from: "ok"))
        XCTAssertNil(Spotify.reading(from: line("buffering", "50", "0", "false", "false")))
        XCTAssertNil(Spotify.reading(from: line("playing", "50")))
    }

    func testOddFieldsAreLeftOut() throws {
        let reading = try XCTUnwrap(Spotify.reading(from: line("Playing", "loud", "soon", "maybe", "")))
        XCTAssertEqual(reading.state, .playing)
        XCTAssertNil(reading.volume)
        XCTAssertNil(reading.position)
        XCTAssertNil(reading.shuffling)
        XCTAssertNil(reading.repeating)
    }

    // MARK: The notification

    func testTheNotification() throws {
        let userInfo: [AnyHashable: Any] = [
            "Player State": "Playing", "Track ID": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "Name": "Never Gonna Give You Up",
            "Artist": "Rick Astley", "Album": "Whenever You Need Somebody", "Album Artist": "Rick Astley",
            "Duration": NSNumber(value: 213_573), "Playback Position": NSNumber(value: 12.5), "Has Artwork": true,
            "Disc Number": 1, "Track Number": 1, "Popularity": 80, "Starred": false, "Play Count": 0,
        ]
        let reading = try XCTUnwrap(Spotify.reading(fromNotification: userInfo))
        XCTAssertEqual(reading.state, .playing)
        XCTAssertNil(reading.volume)
        let now = try XCTUnwrap(reading.nowPlaying(at: date))
        XCTAssertEqual(now.title, "Never Gonna Give You Up")
        XCTAssertEqual(now.artist, "Rick Astley")
        XCTAssertEqual(now.album, "Whenever You Need Somebody")
        XCTAssertEqual(try XCTUnwrap(now.duration), 213.573, accuracy: 0.0001)
        XCTAssertEqual(now.position, 12.5)
        XCTAssertEqual(now.trackId, "spotify:track:4uLU6hMCjMI75M1A2tKUQC")
        XCTAssertNil(now.artworkURL)
    }

    func testTheNotificationWhenItStops() throws {
        let reading = try XCTUnwrap(Spotify.reading(fromNotification: ["Player State": "Stopped"]))
        XCTAssertEqual(reading.state, .stopped)
        XCTAssertNil(reading.nowPlaying(at: date))
    }

    func testANotificationWithNumbersAsText() throws {
        let userInfo: [AnyHashable: Any] = [
            "Player State": "Paused", "Track ID": "spotify:track:x", "Name": "Song", "Duration": "185000", "Playback Position": "1.5",
        ]
        let now = try XCTUnwrap(Spotify.reading(fromNotification: userInfo)?.nowPlaying(at: date))
        XCTAssertFalse(now.isPlaying)
        XCTAssertEqual(now.duration, 185)
        XCTAssertEqual(now.position, 1.5)
        XCTAssertEqual(now.artist, "")
    }

    /// Seconds or milliseconds, from either: no track lasts ten hours.
    func testDurationsInEitherUnit() throws {
        func script(_ duration: String) -> TimeInterval? {
            Spotify.reading(from: line("playing", "50", "0", "false", "false", "spotify:track:x", "S", "A", "B", duration, ""))?.track?
                .duration
        }
        func notification(_ duration: Any) -> TimeInterval? {
            Spotify.reading(fromNotification: ["Player State": "Playing", "Track ID": "spotify:track:x", "Duration": duration])?.track?
                .duration
        }
        XCTAssertEqual(try XCTUnwrap(script("213573")), 213.573, accuracy: 0.0001)
        XCTAssertEqual(script("213"), 213)
        XCTAssertEqual(try XCTUnwrap(notification(NSNumber(value: 213_573))), 213.573, accuracy: 0.0001)
        XCTAssertEqual(notification(NSNumber(value: 213)), 213)
        XCTAssertEqual(notification(NSNumber(value: 213.5)), 213.5)
        // A long podcast in seconds, and the line between the two.
        XCTAssertEqual(script("7200"), 7_200)
        XCTAssertEqual(script("36000"), 36_000)
        XCTAssertEqual(try XCTUnwrap(script("36001")), 36.001, accuracy: 0.0001)
        XCTAssertNil(script("0"))
        XCTAssertNil(script("-5"))
        XCTAssertNil(script("missing value"))
        XCTAssertNil(notification("soon"))
    }

    func testWhatIsNoNotification() {
        XCTAssertNil(Spotify.reading(fromNotification: [:]))
        XCTAssertNil(Spotify.reading(fromNotification: ["Player State": 1]))
        XCTAssertNil(Spotify.reading(fromNotification: ["Player State": "Rewinding"]))
    }

    // MARK: Scripts

    func testEveryScriptChecksThatSpotifyRunsFirst() {
        let commands: [MusicCommand] = [.playPause, .nextTrack, .previousTrack, .seek(12), .volume(40)]
        for script in [Spotify.readScript] + commands.map(Spotify.script(for:)) {
            XCTAssert(script.hasPrefix(#"if application id "com.spotify.client" is not running then return """#), script)
            XCTAssert(script.contains("with timeout of 5 seconds"), script)
            XCTAssertFalse(script.contains(#"application "Spotify""#), script)
        }
    }

    func testTheCommands() {
        XCTAssert(Spotify.script(for: .playPause).contains(#"tell application id "com.spotify.client" to playpause"#))
        XCTAssert(Spotify.script(for: .nextTrack).contains("to next track\n"))
        XCTAssert(Spotify.script(for: .previousTrack).contains("to previous track\n"))
        XCTAssert(Spotify.script(for: .volume(40)).contains("to set sound volume to 40\n"))
        XCTAssert(Spotify.script(for: .volume(140)).contains("to set sound volume to 100\n"))
        XCTAssert(Spotify.script(for: .volume(-3)).contains("to set sound volume to 0\n"))
        XCTAssert(Spotify.script(for: .seek(-1)).contains("to set player position to 0.000\n"))
        XCTAssert(Spotify.script(for: .seek(.nan)).contains("to set player position to 0.000\n"))
    }

    /// AppleScript reads a decimal point whatever the Mac's language.
    func testASeekIsWrittenWithAPointInFrench() {
        let locale = Strings.locale
        defer { Strings.locale = locale }
        Strings.locale = Locale(identifier: "fr_FR")
        XCTAssert(Spotify.script(for: .seek(83.25)).contains("to set player position to 83.250\n"))
    }

    // MARK: Covers

    func testOnlySpotifysOwnCoversAreDownloaded() {
        XCTAssertNotNil(Spotify.artworkURL(cover))
        XCTAssertNotNil(Spotify.artworkURL("https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02"))
        XCTAssertNotNil(Spotify.artworkURL(" https://I.SCDN.CO/image/x "))
        XCTAssertNil(Spotify.artworkURL("http://i.scdn.co/image/x"))
        XCTAssertNil(Spotify.artworkURL("https://example.com/image/x"))
        XCTAssertNil(Spotify.artworkURL("https://scdn.co.example.com/x"))
        XCTAssertNil(Spotify.artworkURL("https://evilscdn.co/x"))
        XCTAssertNil(Spotify.artworkURL("file:///etc/passwd"))
        XCTAssertNil(Spotify.artworkURL("missing value"))
        XCTAssertNil(Spotify.artworkURL(""))
    }
}
