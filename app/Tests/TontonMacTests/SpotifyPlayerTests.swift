import Foundation
import TontonCore
import XCTest

@testable import TontonMac

/// The Spotify bridge with fakes for AppleScript, the Automation permission, the running apps and the notification: no
/// Apple Event leaves these tests, nothing is asked and nothing is launched.
@MainActor
final class SpotifyPlayerTests: XCTestCase {
    private final class Scripts: ScriptRunning, @unchecked Sendable {
        private let lock = NSLock()
        private var _sent: [String] = []
        private var _answer: @Sendable (String) throws -> String = { _ in "" }
        var delay: UInt64 = 0

        var sent: [String] { lock.withLock { _sent } }
        var reads: Int { sent.filter { $0 == Spotify.readScript }.count }
        var commands: [String] { sent.filter { $0 != Spotify.readScript } }

        func answer(_ answer: @escaping @Sendable (String) throws -> String) { lock.withLock { _answer = answer } }

        func run(_ source: String) async throws -> String {
            let answer = lock.withLock {
                _sent.append(source)
                return _answer
            }
            if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
            return try answer(source)
        }
    }

    private final class Access: AutomationAccess, @unchecked Sendable {
        private let lock = NSLock()
        private var _answer: MusicAccess
        private var _asked = 0
        init(_ answer: MusicAccess) { _answer = answer }
        var asked: Int { lock.withLock { _asked } }
        func set(_ answer: MusicAccess) { lock.withLock { _answer = answer } }
        func request(_ bundleId: String) async -> MusicAccess {
            lock.withLock {
                _asked += 1
                return _answer
            }
        }
    }

    private final class Apps: RunningApps {
        var installed = true
        var running = false
        var activated: [String] = []
        var launched: [String] = []
        private var handlers: [String: [@MainActor (Bool) -> Void]] = [:]

        func isInstalled(_ bundleId: String) -> Bool { installed }
        func isRunning(_ bundleId: String) -> Bool { running }
        func observe(_ bundleId: String, _ change: @escaping @MainActor (Bool) -> Void) { handlers[bundleId, default: []].append(change) }
        func activate(_ bundleId: String) { activated.append(bundleId) }
        func launch(_ bundleId: String) { launched.append(bundleId) }

        func set(running: Bool) {
            self.running = running
            for handler in handlers[Spotify.bundleId] ?? [] { handler(running) }
        }
    }

    private final class Notifications: NotificationSource {
        private var handlers: [String: [@MainActor ([AnyHashable: Any]) -> Void]] = [:]
        func observe(_ name: String, _ handler: @escaping @MainActor ([AnyHashable: Any]) -> Void) {
            handlers[name, default: []].append(handler)
        }
        func post(_ userInfo: [AnyHashable: Any]) {
            for handler in handlers[Spotify.playbackChanged] ?? [] { handler(userInfo) }
        }
    }

    private var scripts = Scripts()
    private var access = Access(.granted)
    private var apps = Apps()
    private var notifications = Notifications()

    /// The addresses covers were asked for, and the bytes each gets.
    private final class Downloads: @unchecked Sendable {
        private let lock = NSLock()
        private var _asked: [URL] = []
        var asked: [URL] { lock.withLock { _asked } }
        func download(_ url: URL) async -> Data? {
            lock.withLock { _asked.append(url) }
            return Data("cover".utf8)
        }
    }

    private var downloads = Downloads()

    private func player() -> SpotifyPlayer {
        let downloads = downloads
        return SpotifyPlayer(
            scripts: scripts, access: access, apps: apps, notifications: notifications, download: { await downloads.download($0) },
            launchDelay: 0)
    }

    /// Polls until `condition` holds: the player answers from tasks.
    private func eventually(
        _ what: String, timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool
    ) async {
        let end = Date().addingTimeInterval(timeout)
        while !condition(), Date() < end { try? await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(condition(), what, file: file, line: line)
    }

    /// Lets the player's tasks run, to check that something does not happen.
    private func settle() async { try? await Task.sleep(nanoseconds: 100_000_000) }

    override func setUp() async throws {
        scripts = Scripts()
        access = Access(.granted)
        apps = Apps()
        notifications = Notifications()
        downloads = Downloads()
        scripts.answer { _ in Fixture.playing }
    }

    func testNothingGoesOutBeforeStart() async {
        apps.running = true
        let player = player()
        player.refresh()
        player.perform(.playPause)
        notifications.post(["Player State": "Playing"])
        await settle()
        XCTAssertEqual(scripts.sent, [])
        XCTAssertEqual(access.asked, 0)
        XCTAssertEqual(player.state.screen, .notRunning)
    }

    func testNothingGoesOutWhileSpotifyDoesNotRun() async {
        let player = player()
        player.start()
        player.refresh()
        player.perform(.nextTrack)
        notifications.post(["Player State": "Playing", "Track ID": "spotify:track:1", "Name": "Song"])
        await settle()
        XCTAssertEqual(scripts.sent, [])
        XCTAssertEqual(access.asked, 0)
        XCTAssertEqual(player.state.screen, .notRunning)
    }

    func testNotInstalled() {
        apps.installed = false
        let player = player()
        player.start()
        XCTAssertEqual(player.state.screen, .notInstalled)
    }

    func testItAsksThenReads() async throws {
        apps.running = true
        let player = player()
        var changes = 0
        player.onChange = { _ in changes += 1 }
        player.start()
        await eventually("a read") { player.state.nowPlaying != nil }
        XCTAssertEqual(access.asked, 1)
        XCTAssertEqual(scripts.sent, [Spotify.readScript])
        let now = try XCTUnwrap(player.state.nowPlaying)
        XCTAssertEqual(now.title, "Song")
        XCTAssertTrue(now.isPlaying)
        XCTAssertEqual(now.volume, 60)
        XCTAssertEqual(player.state.access, .granted)
        XCTAssertGreaterThan(changes, 0)
        // Starting again changes nothing.
        player.start()
        await settle()
        XCTAssertEqual(scripts.sent.count, 1)
    }

    func testDenied() async {
        apps.running = true
        access.set(.denied)
        let player = player()
        player.start()
        await eventually("denied") { player.state.screen == .denied }
        player.perform(.playPause)
        await settle()
        XCTAssertEqual(scripts.sent, [])
        // Allowed in System Settings since: the next refresh finds it, without a prompt from Tonton.
        access.set(.granted)
        player.refresh()
        await eventually("allowed") { player.state.nowPlaying != nil }
        XCTAssertEqual(access.asked, 2)
    }

    func testTurnedOffSinceShowsDenied() async {
        apps.running = true
        scripts.answer { _ in throw ScriptFailure(code: MusicAccess.notPermittedError) }
        let player = player()
        player.start()
        await eventually("denied") { player.state.access == .denied }
        XCTAssertEqual(player.state.screen, .denied)
    }

    func testOtherFailuresKeepWhatShows() async {
        apps.running = true
        let player = player()
        player.start()
        await eventually("a read") { player.state.nowPlaying != nil }
        scripts.answer { _ in throw ScriptFailure(code: -1712) }
        player.refresh()
        await eventually("a second read") { self.scripts.reads == 2 }
        await settle()
        XCTAssertEqual(player.state.nowPlaying?.title, "Song")
        XCTAssertEqual(player.state.access, .granted)
    }

    func testLaunchAndQuit() async {
        let player = player()
        player.start()
        apps.set(running: true)
        await eventually("a read once Spotify runs") { player.state.nowPlaying != nil }
        apps.set(running: false)
        XCTAssertFalse(player.state.running)
        XCTAssertNil(player.state.nowPlaying)
        XCTAssertEqual(player.state.screen, .notRunning)
    }

    func testAnAnswerFromBeforeItQuitIsDropped() async {
        apps.running = true
        let player = player()
        scripts.delay = 200_000_000
        player.start()
        await eventually("a read on its way") { self.scripts.reads == 1 }
        apps.set(running: false)
        await settle()
        await settle()
        XCTAssertNil(player.state.nowPlaying)
    }

    func testANotificationShowsAtOnceThenReads() async throws {
        apps.running = true
        let player = player()
        player.start()
        await eventually("a read") { player.state.nowPlaying != nil }
        scripts.answer { _ in Fixture.paused }
        notifications.post([
            "Player State": "Paused", "Track ID": "spotify:track:1", "Name": "Song", "Artist": "Artist", "Album": "Album",
            "Duration": 200_000, "Playback Position": 31.0,
        ])
        // At once, keeping the volume and the cover the notification doesn't have.
        let now = try XCTUnwrap(player.state.nowPlaying)
        XCTAssertFalse(now.isPlaying)
        XCTAssertEqual(now.position, 31)
        XCTAssertEqual(now.volume, 60)
        XCTAssertEqual(now.artworkURL?.absoluteString, "https://i.scdn.co/image/1")
        await eventually("a read after it") { self.scripts.reads == 2 }
    }

    func testCommands() async throws {
        apps.running = true
        let player = player()
        player.start()
        await eventually("a read") { player.state.nowPlaying != nil }
        scripts.answer { source in source == Spotify.readScript ? Fixture.paused : "ok" }
        player.perform(.playPause)
        // Shown before Spotify answers.
        XCTAssertEqual(player.state.nowPlaying?.isPlaying, false)
        await eventually("the command, then a read") { self.scripts.reads == 2 }
        XCTAssertEqual(scripts.commands, [Spotify.script(for: .playPause)])
        player.perform(.seek(90))
        player.perform(.nextTrack)
        player.perform(.previousTrack)
        await eventually("each command") { self.scripts.commands.count == 4 }
        XCTAssertEqual(
            Set(scripts.commands), Set([MusicCommand.playPause, .seek(90), .nextTrack, .previousTrack].map(Spotify.script(for:))))
    }

    func testTheVolumeSendsItsLastValue() async throws {
        apps.running = true
        let player = player()
        player.start()
        await eventually("a read") { player.state.nowPlaying != nil }
        scripts.answer { _ in "ok" }
        scripts.delay = 200_000_000
        player.perform(.volume(10))
        await eventually("the first volume") { self.scripts.commands.count == 1 }
        for volume in stride(from: 20, through: 50, by: 10) { player.perform(.volume(volume)) }
        XCTAssertEqual(player.state.nowPlaying?.volume, 50)
        await eventually("the last volume") { self.scripts.commands.last == Spotify.script(for: .volume(50)) }
        await settle()
        // The last goes once the first is set; those in between are skipped. No read follows a volume.
        XCTAssertEqual(scripts.commands, [Spotify.script(for: .volume(10)), Spotify.script(for: .volume(50))])
        XCTAssertEqual(scripts.reads, 1)
    }

    func testCoversComeOnlyFromSpotifysImageServer() async throws {
        let player = player()
        func track(_ cover: String?, app: String = Spotify.bundleId) -> NowPlaying {
            NowPlaying(
                app: app, title: "Song", artist: "Artist", album: "Album", isPlaying: true, artworkURL: cover.flatMap { URL(string: $0) })
        }
        let cover = "https://i.scdn.co/image/ab67616d0000b273"
        let data = await player.artwork(for: track(cover))
        XCTAssertEqual(data, Data("cover".utf8))
        let none = await player.artwork(for: track(nil))
        let elsewhere = await player.artwork(for: track("https://example.com/cover.jpg"))
        let otherPlayer = await player.artwork(for: track(cover, app: "com.apple.Music"))
        XCTAssertNil(none)
        XCTAssertNil(elsewhere)
        XCTAssertNil(otherPlayer)
        XCTAssertEqual(downloads.asked, [try XCTUnwrap(URL(string: cover))])
        // A cover is no Apple Event.
        XCTAssertEqual(scripts.sent, [])
    }

    func testActivateAndLaunchGoThroughTheApps() {
        let player = player()
        player.activate()
        player.launch()
        XCTAssertEqual(apps.activated, [Spotify.bundleId])
        XCTAssertEqual(apps.launched, [Spotify.bundleId])
        XCTAssertEqual(scripts.sent, [])
    }
}

/// Lines as `Spotify.readScript` writes them.
private enum Fixture {
    static func line(_ fields: String...) -> String { fields.joined(separator: "\u{1F}") }
    static let playing = line(
        "playing", "60", "30000", "false", "false", "spotify:track:1", "Song", "Artist", "Album", "200000", "https://i.scdn.co/image/1")
    static let paused = line(
        "paused", "60", "30000", "false", "false", "spotify:track:1", "Song", "Artist", "Album", "200000", "https://i.scdn.co/image/1")
}
