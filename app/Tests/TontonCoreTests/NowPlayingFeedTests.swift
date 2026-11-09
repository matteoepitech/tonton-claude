import Foundation
import XCTest

@testable import TontonCore

/// What mediaremote-adapter's `stream` says, from lines written the way its stream.m and helpers.m write them (compact
/// NSJSONSerialization, which escapes slashes): no test reads this Mac's Now Playing.
final class NowPlayingFeedTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 2_000_000_000)

    /// Deezer's desktop app plays a track, with a JPEG cover.
    private let playing = """
        {"type":"data","diff":false,"payload":{"bundleIdentifier":"com.deezer.deezer-desktop","playing":true,\
        "processIdentifier":4242,"title":"Song","artist":"Artist","album":"Album","durationMicros":215000000,\
        "elapsedTimeMicros":31500000,"timestampEpochMicros":1762680000250000,"playbackRate":1,\
        "artworkMimeType":"image\\/jpeg","artworkData":"\\/9j\\/4AAQSkZJRg==","contentItemIdentifier":"item-1",\
        "mediaType":"MRMediaRemoteMediaTypeMusic","shuffleMode":1,"repeatMode":3}}
        """

    private func feed(_ lines: String...) -> NowPlayingFeed {
        var feed = NowPlayingFeed()
        for line in lines { feed.apply(Data(line.utf8)) }
        return feed
    }

    func testATrackThatPlays() throws {
        let feed = feed(playing)
        let now = try XCTUnwrap(feed.nowPlaying(at: date))
        XCTAssertEqual(now.app, "com.deezer.deezer-desktop")
        XCTAssertEqual(now.title, "Song")
        XCTAssertEqual(now.artist, "Artist")
        XCTAssertEqual(now.album, "Album")
        XCTAssertTrue(now.isPlaying)
        XCTAssertEqual(try XCTUnwrap(now.duration), 215, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(now.position), 31.5, accuracy: 0.0001)
        // Where the track was when MediaRemote said so, not when the line was read.
        XCTAssertEqual(now.positionDate.timeIntervalSince1970, 1_762_680_000.25, accuracy: 0.0001)
        XCTAssertEqual(now.trackId, "item-1")
        XCTAssertEqual(now.shuffling, false)
        XCTAssertEqual(now.repeating, true)
        XCTAssertNil(now.volume)
        XCTAssertNil(now.artworkURL)
        XCTAssertEqual(feed.artwork?.prefix(4), Data([0xFF, 0xD8, 0xFF, 0xE0]))
    }

    func testADiffChangesOnlyWhatItHolds() throws {
        var feed = feed(playing)
        let pause = #"{"type":"data","diff":true,"payload":{"playing":false,"elapsedTimeMicros":40000000,"playbackRate":0}}"#
        let changed = feed.apply(Data(pause.utf8))
        XCTAssertEqual(changed, ["playing", "elapsedTimeMicros", "playbackRate"])
        let now = try XCTUnwrap(feed.nowPlaying(at: date))
        XCTAssertFalse(now.isPlaying)
        XCTAssertEqual(now.position, 40)
        XCTAssertEqual(now.title, "Song")
        XCTAssertNotNil(feed.artwork)
    }

    func testANullRemovesAKey() {
        let feed = feed(playing, #"{"type":"data","diff":true,"payload":{"artworkData":null,"artworkMimeType":null}}"#)
        XCTAssertNil(feed.artwork)
        XCTAssertNil(feed.payload["artworkMimeType"])
        XCTAssertEqual(feed.nowPlaying(at: date)?.title, "Song")
    }

    func testAnEmptyPayloadIsNothing() {
        let feed = feed(playing, #"{"type":"data","diff":false,"payload":{}}"#)
        XCTAssertTrue(feed.isEmpty)
        XCTAssertNil(feed.nowPlaying(at: date))
        XCTAssertNil(feed.artwork)
    }

    func testAFullPayloadReplacesEverything() throws {
        let next = """
            {"type":"data","diff":false,"payload":{"bundleIdentifier":"com.deezer.deezer-desktop","playing":true,\
            "processIdentifier":4242,"title":"Next"}}
            """
        let now = try XCTUnwrap(feed(playing, next).nowPlaying(at: date))
        XCTAssertEqual(now.title, "Next")
        XCTAssertEqual(now.album, "")
        XCTAssertNil(now.duration)
        // No timestamp: the time the line was read.
        XCTAssertEqual(now.positionDate, date)
        XCTAssertNil(feed(playing, next).artwork)
    }

    func testSpotifyAndAppleMusicKeepTheirOwnWay() {
        for app in ["com.spotify.client", "com.apple.Music"] {
            let own = feed(#"{"type":"data","diff":false,"payload":{"bundleIdentifier":"\#(app)","playing":true,"title":"Song"}}"#)
            XCTAssertTrue(own.isOwnPlayer, app)
            XCTAssertFalse(own.isEmpty)
            XCTAssertNil(own.nowPlaying(at: date), app)
        }
    }

    func testAWebPlayerIsItsBrowser() throws {
        let safari = feed(
            """
            {"type":"data","diff":false,"payload":{"bundleIdentifier":"com.apple.WebKit.GPU",\
            "parentApplicationBundleIdentifier":"com.apple.Safari","playing":true,"processIdentifier":7,"title":"Video"}}
            """)
        XCTAssertEqual(try XCTUnwrap(safari.nowPlaying(at: date)).app, "com.apple.Safari")
    }

    func testAProcessWithoutAnAppShowsNothing() {
        let tool = feed(#"{"type":"data","diff":false,"payload":{"playing":true,"processIdentifier":7,"title":"Song"}}"#)
        XCTAssertFalse(tool.isEmpty)
        XCTAssertNil(tool.nowPlaying(at: date))
    }

    /// `--allow-missing-title`: an untagged file still says which app plays.
    func testNoTitle() throws {
        let untagged = feed(
            #"{"type":"data","diff":false,"payload":{"bundleIdentifier":"org.videolan.vlc","playing":true,"processIdentifier":7}}"#)
        let now = try XCTUnwrap(untagged.nowPlaying(at: date))
        XCTAssertEqual(now.title, "")
        XCTAssertEqual(now.app, "org.videolan.vlc")
    }

    func testWhatItDoesNotKnowIsSkipped() throws {
        var feed = feed(playing)
        for line in ["", "not json", "[1,2]", #"{"type":"error","message":"x"}"#, #"{"diff":false,"payload":{}}"#] {
            XCTAssertNil(feed.apply(Data(line.utf8)), line)
        }
        XCTAssertEqual(feed.nowPlaying(at: date)?.title, "Song")
        // Values of a kind no key read here holds, and a playing state given as a number.
        let odd = #"{"type":"data","diff":true,"payload":{"queue":[1,2],"extra":{"a":1},"playing":0}}"#
        XCTAssertNotNil(feed.apply(Data(odd.utf8)))
        XCTAssertEqual(feed.payload["queue"], .other)
        XCTAssertFalse(try XCTUnwrap(feed.nowPlaying(at: date)).isPlaying)
    }

    func testTheArguments() {
        XCTAssertEqual(MediaRemoteAdapter.streamArguments.first, "stream")
        XCTAssertTrue(MediaRemoteAdapter.streamArguments.contains("--micros"))
        XCTAssertEqual(MediaRemoteAdapter.arguments(for: .playPause), ["send", "2"])
        XCTAssertEqual(MediaRemoteAdapter.arguments(for: .nextTrack), ["send", "4"])
        XCTAssertEqual(MediaRemoteAdapter.arguments(for: .previousTrack), ["send", "5"])
        XCTAssertEqual(MediaRemoteAdapter.arguments(for: .seek(83.25)), ["seek", "83250000"])
        XCTAssertEqual(MediaRemoteAdapter.arguments(for: .seek(-3)), ["seek", "0"])
        XCTAssertEqual(MediaRemoteAdapter.arguments(for: .seek(.nan)), ["seek", "0"])
        XCTAssertNil(MediaRemoteAdapter.arguments(for: .volume(50)))
    }

    func testRestartsWaitLongerEachTime() {
        var restarts = AdapterRestarts()
        XCTAssertEqual(restarts.stopped(afterRunning: 1), 1)
        XCTAssertEqual(restarts.stopped(afterRunning: 1), 2)
        XCTAssertFalse(restarts.failing)
        XCTAssertEqual(restarts.stopped(afterRunning: 1), 4)
        XCTAssertTrue(restarts.failing)
        for _ in 0..<20 { _ = restarts.stopped(afterRunning: 0) }
        XCTAssertEqual(restarts.stopped(afterRunning: 0), AdapterRestarts.maxDelay)
        // A good run starts the count again.
        XCTAssertEqual(restarts.stopped(afterRunning: AdapterRestarts.goodRun), 1)
        XCTAssertFalse(restarts.failing)
    }

    func testLinesAcrossChunks() {
        var buffer = LineBuffer()
        XCTAssertEqual(buffer.append(Data("{\"a\":".utf8)), [])
        XCTAssertEqual(buffer.append(Data("1}\n\n{\"b\":2}\n{\"c\"".utf8)), [Data("{\"a\":1}".utf8), Data("{\"b\":2}".utf8)])
        XCTAssertEqual(buffer.append(Data(":3}\n".utf8)), [Data("{\"c\":3}".utf8)])
    }

    func testALineTooLongIsDroppedWhole() {
        var buffer = LineBuffer(maxLength: 8)
        XCTAssertEqual(buffer.append(Data("0123456789".utf8)), [])
        XCTAssertEqual(buffer.append(Data("abc\nok\n".utf8)), [Data("ok".utf8)])
        XCTAssertEqual(buffer.append(Data("12345678\n123456789\nend\n".utf8)), [Data("12345678".utf8), Data("end".utf8)])
    }
}
