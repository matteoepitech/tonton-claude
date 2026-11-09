import Foundation
import TontonCore
import XCTest

@testable import TontonMac

/// The Apple Music bridge with fakes for AppleScript, the Automation permission, the running apps and the notifications:
/// no Apple Event leaves these tests, nothing is asked and nothing is launched.
@MainActor
final class AppleMusicPlayerTests: XCTestCase {
    private final class Scripts: ScriptRunning, @unchecked Sendable {
        private let lock = NSLock()
        private var _sent: [String] = []
        private var _answer: @Sendable (String) throws -> String = { _ in "" }
        private var _bytes: @Sendable (String) throws -> Data = { _ in Data() }
        var delay: UInt64 = 0

        var sent: [String] { lock.withLock { _sent } }
        var reads: Int { sent.filter { $0 == AppleMusic.readScript }.count }
        var covers: [String] { sent.filter { $0.contains("data of artwork") } }
        var commands: [String] { sent.filter { $0 != AppleMusic.readScript && !$0.contains("data of artwork") } }

        func answer(_ answer: @escaping @Sendable (String) throws -> String) { lock.withLock { _answer = answer } }
        func bytes(_ bytes: @escaping @Sendable (String) throws -> Data) { lock.withLock { _bytes = bytes } }

        func run(_ source: String) async throws -> String {
            let answer = lock.withLock {
                _sent.append(source)
                return _answer
            }
            if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
            return try answer(source)
        }

        func data(_ source: String) async throws -> Data {
            let bytes = lock.withLock {
                _sent.append(source)
                return _bytes
            }
            if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
            return try bytes(source)
        }
    }

    private final class Access: AutomationAccess, @unchecked Sendable {
        private let lock = NSLock()
        private var _answer: MusicAccess
        private var _asked: [String] = []
        init(_ answer: MusicAccess) { _answer = answer }
        var asked: [String] { lock.withLock { _asked } }
        func set(_ answer: MusicAccess) { lock.withLock { _answer = answer } }
        func request(_ bundleId: String) async -> MusicAccess {
            lock.withLock {
                _asked.append(bundleId)
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
            for handler in handlers[AppleMusic.bundleId] ?? [] { handler(running) }
        }
    }

    private final class Notifications: NotificationSource {
        private var handlers: [String: [@MainActor ([AnyHashable: Any]) -> Void]] = [:]
        var names: Set<String> { Set(handlers.keys) }
        func observe(_ name: String, _ handler: @escaping @MainActor ([AnyHashable: Any]) -> Void) {
            handlers[name, default: []].append(handler)
        }
        func post(_ userInfo: [AnyHashable: Any], as name: String = AppleMusic.playerInfo) {
            for handler in handlers[name] ?? [] { handler(userInfo) }
        }
    }

    private var scripts = Scripts()
    private var access = Access(.granted)
    private var apps = Apps()
    private var notifications = Notifications()

    private func player() -> AppleMusicPlayer {
        AppleMusicPlayer(scripts: scripts, access: access, apps: apps, notifications: notifications, launchDelay: 0)
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

    /// A player that runs, is allowed and has read its track.
    private func playing() async -> AppleMusicPlayer {
        apps.running = true
        let player = player()
        player.start()
        await eventually("a read") { player.state.nowPlaying != nil }
        return player
    }

    override func setUp() async throws {
        scripts = Scripts()
        access = Access(.granted)
        apps = Apps()
        notifications = Notifications()
        scripts.answer { _ in Fixture.playing }
    }

    func testNothingGoesOutBeforeStart() async {
        apps.running = true
        let player = player()
        player.refresh()
        player.perform(.playPause)
        notifications.post(Fixture.notice("Playing"))
        let cover = await player.artwork(for: Fixture.track)
        await settle()
        XCTAssertNil(cover)
        XCTAssertEqual(scripts.sent, [])
        XCTAssertEqual(access.asked, [])
        XCTAssertEqual(player.state.screen, .notRunning)
    }

    func testNothingGoesOutWhileMusicDoesNotRun() async {
        let player = player()
        player.start()
        player.refresh()
        player.perform(.nextTrack)
        notifications.post(Fixture.notice("Playing"))
        let cover = await player.artwork(for: Fixture.track)
        await settle()
        XCTAssertNil(cover)
        XCTAssertEqual(scripts.sent, [])
        XCTAssertEqual(access.asked, [])
        XCTAssertEqual(player.state.screen, .notRunning)
    }

    func testNotInstalled() {
        apps.installed = false
        let player = player()
        player.start()
        XCTAssertEqual(player.state.screen, .notInstalled)
    }

    func testItAsksForItsOwnPermissionThenReads() async throws {
        apps.running = true
        let player = player()
        var changes = 0
        player.onChange = { _ in changes += 1 }
        player.start()
        await eventually("a read") { player.state.nowPlaying != nil }
        XCTAssertEqual(access.asked, ["com.apple.Music"])
        XCTAssertEqual(scripts.sent, [AppleMusic.readScript])
        let now = try XCTUnwrap(player.state.nowPlaying)
        XCTAssertEqual(now.app, "com.apple.Music")
        XCTAssertEqual(now.title, "Song")
        XCTAssertTrue(now.isPlaying)
        XCTAssertEqual(now.volume, 60)
        XCTAssertEqual(now.trackId, "0000000000000ABC")
        XCTAssertEqual(player.state.access, .granted)
        XCTAssertGreaterThan(changes, 0)
        // Starting again changes nothing.
        player.start()
        await settle()
        XCTAssertEqual(scripts.sent.count, 1)
    }

    func testItFollowsBothNamesOfTheNotification() {
        let player = player()
        player.start()
        XCTAssertEqual(notifications.names, ["com.apple.Music.playerInfo", "com.apple.iTunes.playerInfo"])
    }

    func testDenied() async {
        apps.running = true
        access.set(.denied)
        let player = player()
        player.start()
        await eventually("denied") { player.state.screen == .denied }
        player.perform(.playPause)
        notifications.post(Fixture.notice("Paused"))
        let cover = await player.artwork(for: Fixture.track)
        await settle()
        XCTAssertNil(cover)
        XCTAssertEqual(scripts.sent, [])
        // Allowed in System Settings since: the next refresh finds it, without a prompt from Tonton.
        access.set(.granted)
        player.refresh()
        await eventually("allowed") { player.state.nowPlaying != nil }
        XCTAssertEqual(access.asked.count, 2)
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
        let player = await playing()
        scripts.answer { _ in throw ScriptFailure(code: -1712) }
        player.refresh()
        await eventually("a second read") { self.scripts.reads == 2 }
        await settle()
        XCTAssertEqual(player.state.nowPlaying?.title, "Song")
        XCTAssertEqual(player.state.access, .granted)
    }

    func testStoppedShowsNothing() async {
        apps.running = true
        scripts.answer { _ in Fixture.line("stopped", "60", "", "false", "off") }
        let player = player()
        player.start()
        await eventually("a read") { self.scripts.reads == 1 }
        await settle()
        XCTAssertNil(player.state.nowPlaying)
        XCTAssertEqual(player.state.screen, .nothing)
    }

    func testLaunchAndQuit() async {
        let player = player()
        player.start()
        apps.set(running: true)
        await eventually("a read once Music runs") { player.state.nowPlaying != nil }
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
        let player = await playing()
        scripts.answer { _ in Fixture.paused }
        notifications.post(Fixture.notice("Paused"))
        // At once, keeping the volume the notification doesn't have, and the position the track had come to.
        let now = try XCTUnwrap(player.state.nowPlaying)
        XCTAssertFalse(now.isPlaying)
        XCTAssertEqual(now.volume, 60)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(now.position), 30)
        XCTAssertEqual(now.duration, 200)
        await eventually("a read after it") { self.scripts.reads == 2 }
    }

    func testTheCopyUnderITunesNameIsDropped() async {
        let player = await playing()
        notifications.post(Fixture.notice("Paused"))
        notifications.post(Fixture.notice("Paused"), as: AppleMusic.iTunesPlayerInfo)
        await eventually("a read after the first") { self.scripts.reads == 2 }
        await settle()
        XCTAssertEqual(scripts.reads, 2)
        // A change after it still comes through, under either name.
        notifications.post(Fixture.notice("Playing"), as: AppleMusic.iTunesPlayerInfo)
        XCTAssertEqual(player.state.nowPlaying?.isPlaying, true)
        await eventually("a read after the change") { self.scripts.reads == 3 }
    }

    func testANewTrackFromTheNotification() async throws {
        let player = await playing()
        notifications.post(["Player State": "Playing", "Name": "Next", "Artist": "Other", "PersistentID": 0xDEF, "Total Time": 90_000])
        let now = try XCTUnwrap(player.state.nowPlaying)
        XCTAssertEqual(now.title, "Next")
        XCTAssertEqual(now.trackId, "0000000000000DEF")
        XCTAssertNil(now.position)
        XCTAssertEqual(now.duration, 90)
    }

    func testCommands() async throws {
        let player = await playing()
        scripts.answer { source in source == AppleMusic.readScript ? Fixture.paused : "ok" }
        player.perform(.playPause)
        // Shown before Music answers.
        XCTAssertEqual(player.state.nowPlaying?.isPlaying, false)
        await eventually("the command, then a read") { self.scripts.reads == 2 }
        XCTAssertEqual(scripts.commands, [AppleMusic.script(for: .playPause)])
        player.perform(.seek(90))
        player.perform(.nextTrack)
        player.perform(.previousTrack)
        await eventually("each command") { self.scripts.commands.count == 4 }
        XCTAssertEqual(
            Set(scripts.commands), Set([MusicCommand.playPause, .seek(90), .nextTrack, .previousTrack].map(AppleMusic.script(for:))))
    }

    func testTheVolumeSendsItsLastValue() async throws {
        let player = await playing()
        scripts.answer { _ in "ok" }
        scripts.delay = 200_000_000
        player.perform(.volume(10))
        await eventually("the first volume") { self.scripts.commands.count == 1 }
        for volume in stride(from: 20, through: 50, by: 10) { player.perform(.volume(volume)) }
        XCTAssertEqual(player.state.nowPlaying?.volume, 50)
        await eventually("the last volume") { self.scripts.commands.last == AppleMusic.script(for: .volume(50)) }
        await settle()
        XCTAssertEqual(scripts.commands, [AppleMusic.script(for: .volume(10)), AppleMusic.script(for: .volume(50))])
        XCTAssertEqual(scripts.reads, 1)
    }

    // MARK: The cover

    func testTheCoverComesFromMusicForTheTrack() async throws {
        let player = await playing()
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3])
        scripts.bytes { _ in jpeg }
        let now = try XCTUnwrap(player.state.nowPlaying)
        let cover = await player.artwork(for: now)
        XCTAssertEqual(cover, jpeg)
        XCTAssertEqual(scripts.covers, [try XCTUnwrap(AppleMusic.artworkScript(for: "0000000000000ABC"))])
    }

    func testNoCover() async throws {
        let player = await playing()
        func track(_ id: String) -> NowPlaying {
            NowPlaying(app: AppleMusic.bundleId, title: "Song", artist: "", album: "", isPlaying: true, trackId: id)
        }
        // Gone on to another track: the script returns nothing.
        scripts.bytes { _ in Data() }
        let gone = await player.artwork(for: track("A01"))
        XCTAssertNil(gone)
        // No artwork (-1728): no cover, and nothing else changes.
        scripts.bytes { _ in throw ScriptFailure(code: -1728) }
        let none = await player.artwork(for: track("A02"))
        XCTAssertNil(none)
        XCTAssertEqual(player.state.access, .granted)
        // Too big to keep.
        scripts.bytes { _ in Data(count: AppleMusic.maxArtworkBytes + 1) }
        let huge = await player.artwork(for: track("A03"))
        XCTAssertNil(huge)
        XCTAssertEqual(scripts.covers.count, 3)
    }

    func testTheCoverIsReadOncePerTrack() async throws {
        let player = await playing()
        let now = try XCTUnwrap(player.state.nowPlaying)
        scripts.bytes { _ in Data([7]) }
        scripts.delay = 100_000_000
        // Asked twice at once, and again once read, as the read after a notification tells the store more of the track.
        async let first = player.artwork(for: now)
        async let second = player.artwork(for: now)
        let (one, two) = await (first, second)
        let again = await player.artwork(
            for: NowPlaying(app: AppleMusic.bundleId, title: "Song", artist: "Artist", album: "More", isPlaying: false, trackId: "abc"))
        XCTAssertEqual([one, two, again], [Data([7]), Data([7]), Data([7])])
        XCTAssertEqual(scripts.covers.count, 1)
        // Another track is read; Music quit and opened again, the same track is read anew.
        _ = await player.artwork(
            for: NowPlaying(app: AppleMusic.bundleId, title: "Next", artist: "", album: "", isPlaying: true, trackId: "DEF"))
        XCTAssertEqual(scripts.covers.count, 2)
        apps.set(running: false)
        apps.set(running: true)
        await eventually("allowed again") { player.state.nowPlaying != nil }
        _ = await player.artwork(for: now)
        XCTAssertEqual(scripts.covers.count, 3)
    }

    func testACoverIsOnlyAskedForAMusicTrackWithAnId() async {
        let player = await playing()
        scripts.bytes { _ in Data([1]) }
        let spotify = await player.artwork(
            for: NowPlaying(app: Spotify.bundleId, title: "Song", artist: "", album: "", isPlaying: true, trackId: "0000000000000ABC"))
        let noId = await player.artwork(for: NowPlaying(app: AppleMusic.bundleId, title: "Song", artist: "", album: "", isPlaying: true))
        let badId = await player.artwork(
            for: NowPlaying(app: AppleMusic.bundleId, title: "Song", artist: "", album: "", isPlaying: true, trackId: #"1" & quit"#))
        XCTAssertNil(spotify)
        XCTAssertNil(noId)
        XCTAssertNil(badId)
        XCTAssertEqual(scripts.covers, [])
    }

    func testACoverRefusedShowsDenied() async throws {
        let player = await playing()
        scripts.bytes { _ in throw ScriptFailure(code: MusicAccess.notPermittedError) }
        let cover = await player.artwork(for: try XCTUnwrap(player.state.nowPlaying))
        XCTAssertNil(cover)
        XCTAssertEqual(player.state.screen, .denied)
    }

    func testACoverFromBeforeItQuitIsDropped() async throws {
        let player = await playing()
        let now = try XCTUnwrap(player.state.nowPlaying)
        scripts.bytes { _ in Data([1, 2, 3]) }
        scripts.delay = 200_000_000
        async let cover = player.artwork(for: now)
        await eventually("the cover on its way") { self.scripts.covers.count == 1 }
        apps.set(running: false)
        let dropped = await cover
        XCTAssertNil(dropped)
    }

    func testActivateAndLaunchGoThroughTheApps() {
        let player = player()
        player.activate()
        player.launch()
        XCTAssertEqual(apps.activated, [AppleMusic.bundleId])
        XCTAssertEqual(apps.launched, [AppleMusic.bundleId])
        XCTAssertEqual(scripts.sent, [])
    }
}

/// Lines as `AppleMusic.readScript` writes them, and the notification's userInfo.
private enum Fixture {
    static func line(_ fields: String...) -> String { fields.joined(separator: "\u{1F}") }
    static let playing = line("playing", "60", "30000", "false", "off", "0000000000000ABC", "Song", "Artist", "Album", "200000")
    static let paused = line("paused", "60", "30000", "false", "off", "0000000000000ABC", "Song", "Artist", "Album", "200000")
    static let track = NowPlaying(
        app: AppleMusic.bundleId, title: "Song", artist: "Artist", album: "Album", isPlaying: true, trackId: "0000000000000ABC")

    static func notice(_ state: String) -> [AnyHashable: Any] {
        ["Player State": state, "Name": "Song", "Artist": "Artist", "Album": "Album", "PersistentID": 0xABC, "Total Time": 200_000]
    }
}
