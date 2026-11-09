import Foundation
import XCTest

@testable import TontonCore

/// The fallback for when Now Playing can't be read: which app plays sound, and the media keys' events. No key is posted.
final class SoundingAppsTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)
    private let deezer = "com.deezer.deezer-desktop"
    private let chrome = "com.google.Chrome"

    private func apps() -> SoundingApps { SoundingApps(excluding: ["com.spotify.client", "com.apple.Music", "tech.d3l.tontonclaude"]) }

    func testTheKeys() {
        XCTAssertEqual(MediaKey(.playPause), .playPause)
        XCTAssertEqual(MediaKey(.nextTrack), .next)
        XCTAssertEqual(MediaKey(.previousTrack), .previous)
        XCTAssertNil(MediaKey(.seek(3)))
        XCTAssertNil(MediaKey(.volume(3)))
        // ev_keymap.h's NX_KEYTYPE_PLAY in the high half, the key's state in the low one.
        XCTAssertEqual(MediaKey.playPause.data1(down: true), 0x10_0A00)
        XCTAssertEqual(MediaKey.playPause.data1(down: false), 0x10_0B00)
        XCTAssertEqual(MediaKey.next.data1(down: true), 0x11_0A00)
        XCTAssertEqual(MediaKey.previous.data1(down: false), 0x12_0B00)
        XCTAssertEqual(MediaKey.subtype, 8)
    }

    func testTheAppOfAProcess() {
        XCTAssertEqual(SoundingApps.outermostApp("/Applications/Deezer.app/Contents/MacOS/Deezer"), "/Applications/Deezer.app")
        XCTAssertEqual(
            SoundingApps.outermostApp(
                "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/142/Helpers/"
                    + "Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)"),
            "/Applications/Google Chrome.app")
        XCTAssertEqual(
            SoundingApps.outermostApp("/Users/me/Applications/Tidal.app/Contents/MacOS/TIDAL"), "/Users/me/Applications/Tidal.app")
        XCTAssertNil(SoundingApps.outermostApp("/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/x.xpc/Contents/MacOS/x"))
        XCTAssertNil(SoundingApps.outermostApp("/usr/bin/afplay"))
    }

    func testAnAppShowsOnceItHasPlayedAWhile() {
        var apps = apps()
        let next = apps.update([.init(app: deezer, output: true)], at: start)
        // A notification's sound lasts less.
        XCTAssertNil(apps.shown)
        XCTAssertEqual(next, start + SoundingApps.hold)
        _ = apps.update([.init(app: deezer, output: true)], at: start + SoundingApps.hold)
        XCTAssertEqual(apps.shown, .init(app: deezer, sounding: true))
    }

    func testOnceItStopsItStaysPausedWhileItRuns() {
        var apps = apps()
        _ = apps.update([.init(app: deezer, output: true)], at: start)
        _ = apps.update([.init(app: deezer, output: true)], at: start + 4)
        _ = apps.update([.init(app: deezer, output: false)], at: start + 5)
        XCTAssertEqual(apps.shown, .init(app: deezer, sounding: false))
        // It plays again: at once.
        _ = apps.update([.init(app: deezer, output: true)], at: start + 6)
        XCTAssertEqual(apps.shown, .init(app: deezer, sounding: true))
        // It quit: Core Audio no longer lists it.
        _ = apps.update([.init(app: chrome, output: false)], at: start + 7)
        XCTAssertNil(apps.shown)
    }

    func testTheLatestToPlayShows() {
        var apps = apps()
        _ = apps.update([.init(app: deezer, output: true)], at: start)
        _ = apps.update([.init(app: deezer, output: true), .init(app: chrome, output: true)], at: start + 5)
        XCTAssertEqual(apps.shown?.app, deezer)
        _ = apps.update([.init(app: deezer, output: true), .init(app: chrome, output: true)], at: start + 8)
        XCTAssertEqual(apps.shown?.app, chrome)
    }

    func testCallsTheirOwnPlayersAndToolsAreLeftOut() {
        var apps = apps()
        let clients: [SoundingApps.Client] = [
            .init(app: "us.zoom.xos", output: true, input: true), .init(app: "com.spotify.client", output: true),
            .init(app: "com.apple.Music", output: true), .init(app: "tech.d3l.tontonclaude", output: true), .init(app: nil, output: true),
        ]
        _ = apps.update(clients, at: start)
        XCTAssertNil(apps.update(clients, at: start + 60))
        XCTAssertNil(apps.shown)
        XCTAssertFalse(apps.playedLong(at: start + 60))
    }

    func testPlayingLongSaysNowPlayingIsBlind() {
        var apps = apps()
        _ = apps.update([.init(app: deezer, output: true)], at: start)
        let next = apps.update([.init(app: deezer, output: true)], at: start + SoundingApps.hold)
        XCTAssertEqual(next, start + SoundingApps.blindAfter)
        XCTAssertFalse(apps.playedLong(at: start + 9))
        XCTAssertTrue(apps.playedLong(at: start + SoundingApps.blindAfter))
        // Stopped: the count starts again.
        _ = apps.update([.init(app: deezer, output: false)], at: start + 11)
        XCTAssertFalse(apps.playedLong(at: start + 12))
    }
}
