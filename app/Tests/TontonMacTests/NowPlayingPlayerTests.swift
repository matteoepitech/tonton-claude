import Foundation
import TontonCore
import XCTest

@testable import TontonMac

/// The Now Playing player with fakes for the processes, the media keys, Core Audio, the apps and the clock: no perl starts,
/// no key is posted and nothing of this Mac is read.
@MainActor
final class NowPlayingPlayerTests: XCTestCase {
    private final class Launcher: ProcessLaunching {
        final class Child: RunningProcess {
            var stopped = false
            func stop() { stopped = true }
        }

        var streams: [(executable: URL, arguments: [String], child: Child)] = []
        var runs: [[String]] = []
        var failsToStart = false
        private var lines: [@MainActor (Data) -> Void] = []
        private var exits: [@MainActor (Int32) -> Void] = []

        func stream(
            _ executable: URL, _ arguments: [String], line: @escaping @MainActor @Sendable (Data) -> Void,
            exit: @escaping @MainActor @Sendable (Int32) -> Void
        ) throws -> any RunningProcess {
            if failsToStart { throw CocoaError(.fileNoSuchFile) }
            let child = Child()
            streams.append((executable, arguments, child))
            lines.append(line)
            exits.append(exit)
            return child
        }

        func run(_ executable: URL, _ arguments: [String]) async -> Int32? {
            runs.append(arguments)
            return 0
        }

        /// What the child number `index` writes, by default the last one.
        func write(_ line: String, child index: Int? = nil) { lines[index ?? lines.count - 1](Data(line.utf8)) }
        func exit(child index: Int? = nil, status: Int32 = 1) { exits[index ?? exits.count - 1](status) }
    }

    private final class Keys: MediaKeyPosting {
        var allowed = false
        var requested = 0
        var posted: [MediaKey] = []
        func request() { requested += 1 }
        func post(_ key: MediaKey) { posted.append(key) }
    }

    private final class Audio: AudioClientSource {
        var supported = true
        var listening = false
        private var change: (@MainActor ([SoundingApps.Client]) -> Void)?
        func start(_ change: @escaping @MainActor ([SoundingApps.Client]) -> Void) -> Bool {
            guard supported else { return false }
            listening = true
            self.change = change
            change([])
            return true
        }
        func stop() {
            listening = false
            change = nil
        }
        func send(_ clients: [SoundingApps.Client]) { change?(clients) }
    }

    private final class Apps: RunningApps {
        var running: Set<String> = []
        var activated: [String] = []
        var launched: [String] = []
        private var handlers: [String: [@MainActor (Bool) -> Void]] = [:]
        func isInstalled(_ bundleId: String) -> Bool { true }
        func isRunning(_ bundleId: String) -> Bool { running.contains(bundleId) }
        func observe(_ bundleId: String, _ change: @escaping @MainActor (Bool) -> Void) { handlers[bundleId, default: []].append(change) }
        func activate(_ bundleId: String) { activated.append(bundleId) }
        func launch(_ bundleId: String) { launched.append(bundleId) }
        func set(_ bundleId: String, running: Bool) {
            if running { self.running.insert(bundleId) } else { self.running.remove(bundleId) }
            for handler in handlers[bundleId] ?? [] { handler(running) }
        }
    }

    private final class Clock {
        var now = Date(timeIntervalSince1970: 1_000_000)
        func advance(_ seconds: TimeInterval) { now += seconds }
    }

    private let deezer = "com.deezer.deezer-desktop"
    private let files = AdapterFiles(
        script: URL(fileURLWithPath: "/App/Resources/mediaremote-adapter.pl"),
        watcher: URL(fileURLWithPath: "/App/Resources/now-playing.pl"),
        framework: URL(fileURLWithPath: "/App/Frameworks/MediaRemoteAdapter.framework"))
    private var launcher = Launcher()
    private var keys = Keys()
    private var audio = Audio()
    private var apps = Apps()
    private var clock = Clock()

    override func setUp() async throws {
        launcher = Launcher()
        keys = Keys()
        audio = Audio()
        apps = Apps()
        clock = Clock()
    }

    private func player(files: AdapterFiles?? = .none) -> NowPlayingPlayer {
        let clock = clock
        return NowPlayingPlayer(
            apps: apps, launcher: launcher, files: files ?? self.files, keys: keys, audio: audio,
            names: { $0 == "com.deezer.deezer-desktop" ? "Deezer" : nil }, tonton: "tech.d3l.tontonclaude", clock: { clock.now },
            sleep: { _ in try? await Task.sleep(nanoseconds: 2_000_000) })
    }

    private func eventually(
        _ what: String, timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool
    ) async {
        let end = Date().addingTimeInterval(timeout)
        while !condition(), Date() < end { try? await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(condition(), what, file: file, line: line)
    }

    private func settle() async { try? await Task.sleep(nanoseconds: 100_000_000) }

    private func playing(_ app: String = "com.deezer.deezer-desktop", title: String = "Song", artwork: String? = nil) -> String {
        let cover = artwork.map { #","artworkData":"\#($0)","artworkMimeType":"image\/png""# } ?? ""
        return """
            {"type":"data","diff":false,"payload":{"bundleIdentifier":"\(app)","playing":true,"processIdentifier":42,\
            "title":"\(title)","artist":"Artist","album":"Album","durationMicros":200000000,"elapsedTimeMicros":10000000,\
            "timestampEpochMicros":1000000000000\(cover)}}
            """
    }

    private let nothing = #"{"type":"data","diff":false,"payload":{}}"#

    func testNothingStartsBeforeStart() async {
        let player = player()
        player.refresh()
        player.perform(.playPause)
        await settle()
        XCTAssertTrue(launcher.streams.isEmpty)
        XCTAssertTrue(launcher.runs.isEmpty)
        XCTAssertFalse(audio.listening)
        XCTAssertNil(player.state.nowPlaying)
        XCTAssertEqual(player.app, NowPlayingPlayer.noApp)
    }

    func testStartRunsTheStreamOnce() throws {
        let player = player()
        player.start()
        player.start()
        XCTAssertEqual(launcher.streams.count, 1)
        let stream = try XCTUnwrap(launcher.streams.first)
        XCTAssertEqual(stream.executable.path, "/usr/bin/perl")
        XCTAssertEqual(
            stream.arguments,
            [files.watcher.path, files.script.path, files.framework.path, "stream", "--micros", "--allow-missing-title", "--debounce=100"])
        // Until the adapter has read something, Core Audio tells whether it can.
        XCTAssertTrue(audio.listening)
    }

    func testATrackShowsWithItsApp() throws {
        let player = player()
        var changes = 0
        player.onChange = { _ in changes += 1 }
        player.start()
        launcher.write(nothing)
        launcher.write(playing())
        let now = try XCTUnwrap(player.state.nowPlaying)
        XCTAssertEqual(now.title, "Song")
        XCTAssertEqual(now.app, deezer)
        XCTAssertEqual(player.app, deezer)
        XCTAssertEqual(player.name, "Deezer")
        XCTAssertEqual(player.state.screen, .playing(now))
        XCTAssertNil(player.state.mediaKeys)
        XCTAssertGreaterThan(changes, 0)
        // It read something: Core Audio is no longer needed.
        XCTAssertFalse(audio.listening)
    }

    func testSpotifyAndAppleMusicShowNothingHere() {
        apps.running = [deezer]
        let player = player()
        player.start()
        launcher.write(playing("com.spotify.client"))
        XCTAssertNil(player.state.nowPlaying)
        XCTAssertEqual(player.app, NowPlayingPlayer.noApp)
        launcher.write(playing())
        launcher.write(playing("com.apple.Music"))
        XCTAssertNil(player.state.nowPlaying)
        // The app that played stays named while it runs, to bring it to the front.
        XCTAssertEqual(player.app, deezer)
        XCTAssertEqual(player.state.screen, .nothing)
    }

    func testOnceItsTrackIsGoneTheAppStaysWhileItRuns() {
        apps.running = [deezer]
        let player = player()
        player.start()
        launcher.write(playing())
        launcher.write(nothing)
        XCTAssertEqual(player.state.screen, .nothing)
        player.activate()
        XCTAssertEqual(apps.activated, [deezer])
        // Once it quits, the player names no app again, and the music view offers nothing to open.
        apps.set(deezer, running: false)
        XCTAssertEqual(player.app, NowPlayingPlayer.noApp)
        XCTAssertFalse(player.state.installed)
        XCTAssertFalse(player.state.running)
        player.launch()
        XCTAssertEqual(apps.launched, [])
    }

    func testNothingToOpenBeforeAnAppPlays() {
        let player = player()
        player.start()
        launcher.write(nothing)
        XCTAssertEqual(player.app, "")
        XCTAssertEqual(player.name, "")
        XCTAssertFalse(player.state.installed)
        XCTAssertFalse(player.state.running)
        XCTAssertTrue(MusicChoice.openable([MusicChoice.Player(app: player.app, name: player.name, state: player.state)]).isEmpty)
    }

    func testAPlayingAppThatQuitsIsForgotten() {
        apps.running = [deezer]
        let player = player()
        player.start()
        launcher.write(playing())
        XCTAssertTrue(player.state.installed)
        apps.set(deezer, running: false)
        // Still in Now Playing until the adapter says otherwise.
        XCTAssertEqual(player.app, deezer)
        launcher.write(nothing)
        XCTAssertEqual(player.app, "")
    }

    func testNoAppNoLaunch() {
        let player = player()
        player.launch()
        player.activate()
        XCTAssertEqual(apps.launched, [])
        XCTAssertEqual(apps.activated, [])
    }

    func testCommandsGoThroughTheAdapter() async throws {
        let player = player()
        player.start()
        launcher.write(playing())
        player.perform(.playPause)
        // Shown before the stream says so.
        XCTAssertEqual(player.state.nowPlaying?.isPlaying, false)
        player.perform(.nextTrack)
        player.perform(.previousTrack)
        player.perform(.seek(61.5))
        player.perform(.volume(30))
        await eventually("four commands") { self.launcher.runs.count == 4 }
        await settle()
        let base = [files.script.path, files.framework.path]
        XCTAssertEqual(
            Set(launcher.runs), Set([base + ["send", "2"], base + ["send", "4"], base + ["send", "5"], base + ["seek", "61500000"]]))
        XCTAssertTrue(keys.posted.isEmpty)
    }

    func testNoCommandWithNothingShown() async {
        let player = player()
        player.start()
        launcher.write(playing("com.spotify.client"))
        player.perform(.playPause)
        await settle()
        XCTAssertTrue(launcher.runs.isEmpty)
    }

    func testItStartsAgainWhenItDies() async {
        let player = player()
        player.start()
        launcher.write(playing())
        clock.advance(120)
        launcher.exit(child: 0)
        XCTAssertNil(player.state.nowPlaying)
        await eventually("a second child") { self.launcher.streams.count == 2 }
        // What the first one writes now is dropped.
        launcher.write(playing(title: "Old"), child: 0)
        XCTAssertNil(player.state.nowPlaying)
        launcher.write(playing(title: "New"))
        XCTAssertEqual(player.state.nowPlaying?.title, "New")
        XCTAssertNil(player.state.mediaKeys)
    }

    func testDyingOverAndOverFallsBackOnTheKeys() async throws {
        let player = player()
        player.start()
        for count in 1...3 {
            launcher.exit()
            await eventually("child \(count + 1)") { self.launcher.streams.count == count + 1 }
        }
        XCTAssertNotNil(player.state.mediaKeys)
        XCTAssertTrue(audio.listening)
        // Core Audio says Deezer plays: it shows once it has played a moment.
        audio.send([.init(app: deezer, output: true)])
        clock.advance(SoundingApps.hold)
        audio.send([.init(app: deezer, output: true)])
        let now = try XCTUnwrap(player.state.nowPlaying)
        XCTAssertEqual(now.app, deezer)
        XCTAssertEqual(now.title, "")
        XCTAssertTrue(now.isPlaying)
        XCTAssertEqual(player.name, "Deezer")
        XCTAssertEqual(player.state.mediaKeys, .unknown)
        // Not allowed: macOS asks, and no key goes.
        player.perform(.playPause)
        XCTAssertEqual(keys.requested, 1)
        XCTAssertEqual(player.state.mediaKeys, .denied)
        keys.allowed = true
        player.refresh()
        XCTAssertEqual(player.state.mediaKeys, .granted)
        player.perform(.playPause)
        player.perform(.nextTrack)
        player.perform(.seek(10))
        XCTAssertEqual(keys.posted, [.playPause, .next])
        await settle()
        XCTAssertTrue(launcher.runs.isEmpty)
        // The adapter reads again: its track and its controls are back.
        launcher.write(playing(title: "Back"))
        XCTAssertEqual(player.state.nowPlaying?.title, "Back")
        XCTAssertNil(player.state.mediaKeys)
    }

    func testWithoutItsFilesItFallsBackAtOnce() {
        let player = player(files: .some(nil))
        player.start()
        XCTAssertTrue(launcher.streams.isEmpty)
        XCTAssertNotNil(player.state.mediaKeys)
        XCTAssertTrue(audio.listening)
    }

    func testAChildThatCantStartIsTriedAgain() async {
        launcher.failsToStart = true
        let player = player()
        player.start()
        await settle()
        launcher.failsToStart = false
        await eventually("a child once it can start") { self.launcher.streams.count == 1 }
        XCTAssertEqual(player.state.screen, .notInstalled)
    }

    /// The adapter runs but sees nothing while an app plays for a while: Apple may have closed its way in.
    func testAnEmptyStreamWhileAnAppPlaysFallsBack() throws {
        let player = player()
        player.start()
        launcher.write(nothing)
        audio.send([.init(app: deezer, output: true)])
        clock.advance(SoundingApps.blindAfter - 1)
        audio.send([.init(app: deezer, output: true)])
        XCTAssertNil(player.state.mediaKeys)
        clock.advance(1)
        audio.send([.init(app: deezer, output: true)])
        XCTAssertNotNil(player.state.mediaKeys)
        XCTAssertEqual(player.state.nowPlaying?.app, deezer)
        // A call is no music: an app that records too never counts.
        let other = self.player()
        other.start()
        audio.send([.init(app: "us.zoom.xos", output: true, input: true)])
        clock.advance(60)
        audio.send([.init(app: "us.zoom.xos", output: true, input: true)])
        XCTAssertNil(other.state.mediaKeys)
    }

    func testStopEndsTheChildAndStartsNoOther() async throws {
        let player = player()
        player.start()
        player.stop()
        let child = try XCTUnwrap(launcher.streams.first?.child)
        XCTAssertTrue(child.stopped)
        XCTAssertFalse(audio.listening)
        launcher.exit()
        await settle()
        XCTAssertEqual(launcher.streams.count, 1)
    }

    func testTheCoverCanComeAfterTheTrack() async throws {
        let player = player()
        player.start()
        launcher.write(playing())
        let track = try XCTUnwrap(player.state.nowPlaying)
        let cover = Task { await player.artwork(for: track) }
        await settle()
        launcher.write(#"{"type":"data","diff":true,"payload":{"artworkData":"iVBORw0KGgo=","artworkMimeType":"image\/png"}}"#)
        let bytes = await cover.value
        XCTAssertEqual(bytes, Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
        // Already there: at once.
        let again = await player.artwork(for: track)
        XCTAssertEqual(again, bytes)
    }

    func testNoCoverForAnotherTrack() async throws {
        let player = player()
        player.start()
        launcher.write(playing())
        let track = try XCTUnwrap(player.state.nowPlaying)
        let cover = Task { await player.artwork(for: track) }
        await settle()
        launcher.write(playing(title: "Next", artwork: "iVBORw0KGgo="))
        let bytes = await cover.value
        XCTAssertNil(bytes)
        let other = NowPlaying(app: "com.spotify.client", title: "Song", artist: "Artist", album: "Album", isPlaying: true)
        let none = await player.artwork(for: other)
        XCTAssertNil(none)
    }

    func testAWaitForACoverCanBeCancelled() async throws {
        let player = player()
        player.start()
        launcher.write(playing())
        let track = try XCTUnwrap(player.state.nowPlaying)
        let cover = Task { await player.artwork(for: track) }
        await settle()
        cover.cancel()
        let bytes = await cover.value
        XCTAssertNil(bytes)
    }
}
