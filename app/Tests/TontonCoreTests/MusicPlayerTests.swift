import Foundation
import XCTest

@testable import TontonCore

final class MusicPlayerTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    private func track(
        playing: Bool = true, position: TimeInterval? = 30, duration: TimeInterval? = 200, id: String? = "spotify:track:1",
        title: String = "Song", cover: URL? = URL(string: "https://i.scdn.co/image/1"), volume: Int? = 60, modes: Bool = true
    ) -> NowPlaying {
        NowPlaying(
            app: Spotify.bundleId, title: title, artist: "Artist", album: "Album", isPlaying: playing, duration: duration,
            position: position, positionDate: start, trackId: id, artworkURL: cover, volume: volume, shuffling: modes ? false : nil,
            repeating: modes ? true : nil)
    }

    // MARK: What the view shows

    func testTheScreens() {
        XCTAssertEqual(MusicPlayerState(installed: false).screen, .notInstalled)
        XCTAssertEqual(MusicPlayerState(running: false, access: .granted).screen, .notRunning)
        XCTAssertEqual(MusicPlayerState(running: true, access: .unknown).screen, .waiting)
        XCTAssertEqual(MusicPlayerState(running: true, access: .denied, nowPlaying: track()).screen, .denied)
        XCTAssertEqual(MusicPlayerState(running: true, access: .granted).screen, .nothing)
        XCTAssertEqual(MusicPlayerState(running: true, access: .granted, nowPlaying: track()).screen, .playing(track()))
    }

    func testWhatMacOSAnswers() {
        XCTAssertEqual(MusicAccess(automationStatus: 0), .granted)
        XCTAssertEqual(MusicAccess(automationStatus: -1743), .denied)
        XCTAssertEqual(MusicAccess(automationStatus: -1744), .denied)
        // procNotFound: Spotify quit before macOS could tell.
        XCTAssertEqual(MusicAccess(automationStatus: -600), .unknown)
        XCTAssertEqual(MusicAccess(automationStatus: -50), .unknown)
    }

    // MARK: The position

    func testThePositionRunsWhilePlaying() throws {
        let now = track()
        XCTAssertEqual(now.elapsed(at: start), 30)
        XCTAssertEqual(now.elapsed(at: start.addingTimeInterval(12)), 42)
        XCTAssertEqual(try XCTUnwrap(now.progress(at: start.addingTimeInterval(70))), 0.5, accuracy: 0.0001)
        // Never past the end, nor before the start when the clock goes back.
        XCTAssertEqual(now.elapsed(at: start.addingTimeInterval(1_000)), 200)
        XCTAssertEqual(now.elapsed(at: start.addingTimeInterval(-100)), 30)
    }

    func testThePositionStaysWhilePaused() {
        XCTAssertEqual(track(playing: false).elapsed(at: start.addingTimeInterval(60)), 30)
    }

    func testWithoutAPositionOrADuration() {
        XCTAssertNil(track(position: nil).elapsed(at: start))
        XCTAssertNil(track(duration: nil).progress(at: start))
        XCTAssertNil(track(duration: 0).progress(at: start))
        XCTAssertEqual(track(duration: nil).elapsed(at: start.addingTimeInterval(1_000)), 1_030)
    }

    // MARK: Commands, before the player answers

    func testPlayPauseFreezesThePositionWhereItWas() {
        let later = start.addingTimeInterval(10)
        let paused = track().applying(.playPause, at: later)
        XCTAssertFalse(paused.isPlaying)
        XCTAssertEqual(paused.position, 40)
        XCTAssertEqual(paused.positionDate, later)
        let playing = paused.applying(.playPause, at: later.addingTimeInterval(100))
        XCTAssertTrue(playing.isPlaying)
        XCTAssertEqual(playing.elapsed(at: later.addingTimeInterval(105)), 45)
    }

    func testASeek() {
        let later = start.addingTimeInterval(5)
        XCTAssertEqual(track().applying(.seek(120), at: later).elapsed(at: later), 120)
        XCTAssertEqual(track().applying(.seek(500), at: later).position, 200)
        XCTAssertEqual(track().applying(.seek(-5), at: later).position, 0)
    }

    func testTheVolume() {
        XCTAssertEqual(track().applying(.volume(25), at: start).volume, 25)
        XCTAssertEqual(track().applying(.volume(300), at: start).volume, 100)
    }

    func testSkippingWaitsForThePlayer() {
        XCTAssertEqual(track().applying(.nextTrack, at: start), track())
        XCTAssertEqual(track().applying(.previousTrack, at: start), track())
    }

    // MARK: Readings that say less

    func testANotificationKeepsTheVolumeAndTheCoverOfTheSameTrack() {
        let kept = track(playing: false, cover: nil, volume: nil, modes: false).keeping(from: track())
        XCTAssertEqual(kept.volume, 60)
        XCTAssertEqual(kept.artworkURL, track().artworkURL)
        XCTAssertEqual(kept.shuffling, false)
        XCTAssertEqual(kept.repeating, true)
        XCTAssertFalse(kept.isPlaying)
    }

    func testANewTrackKeepsTheVolumeButNotTheCover() {
        let next = track(id: "spotify:track:2", title: "Other", cover: nil, volume: nil)
        let kept = next.keeping(from: track())
        XCTAssertEqual(kept.volume, 60)
        XCTAssertNil(kept.artworkURL)
        XCTAssertEqual(next.keeping(from: nil), next)
    }

    func testWhatANewReadingSaysWins() {
        XCTAssertEqual(track(volume: 10).keeping(from: track()).volume, 10)
        let cover = URL(string: "https://i.scdn.co/image/2")
        XCTAssertEqual(track(cover: cover).keeping(from: track()).artworkURL, cover)
    }

    func testTracksWithoutIdsAreToldApartByWhatTheyShow() {
        XCTAssertTrue(track(id: nil).isSameTrack(as: track(id: nil)))
        XCTAssertFalse(track(id: nil).isSameTrack(as: track(id: nil, title: "Other")))
        XCTAssertFalse(track().isSameTrack(as: track(id: "spotify:track:2")))
    }

    /// One cover per address, which the tracks of an album share, else one per track.
    func testCoverKeys() {
        XCTAssertEqual(track().artworkKey, "https://i.scdn.co/image/1")
        XCTAssertEqual(track(id: "spotify:track:2", title: "Other").artworkKey, track().artworkKey)
        XCTAssertNotEqual(track(cover: nil).artworkKey, track(id: "spotify:track:2", cover: nil).artworkKey)
        XCTAssertNotEqual(track(id: nil, cover: nil).artworkKey, track(id: nil, title: "Other", cover: nil).artworkKey)
        XCTAssertEqual(track(cover: nil).artworkKey, track(playing: false, position: 3, cover: nil).artworkKey)
    }

    // MARK: Time

    func testTrackTimes() {
        XCTAssertEqual(TrackTime.text(0), "0:00")
        XCTAssertEqual(TrackTime.text(7.9), "0:07")
        XCTAssertEqual(TrackTime.text(187), "3:07")
        XCTAssertEqual(TrackTime.text(3_765), "1:02:45")
        XCTAssertEqual(TrackTime.text(-4), "0:00")
        XCTAssertEqual(TrackTime.text(.infinity), "0:00")
    }
}
