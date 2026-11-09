import Foundation
import XCTest

@testable import TontonCore

/// Which player the music view shows, from the players' states and the pin in Settings.
final class MusicChoiceTests: XCTestCase {
    private static let spotify = Spotify.bundleId
    private static let music = "com.apple.Music"
    private static let deezer = "com.deezer.deezer-desktop"

    private typealias Player = MusicChoice.Player
    private enum Shape { case closed, notInstalled, empty, paused, playing }

    private func player(_ app: String, _ shape: Shape) -> Player {
        let track = { (playing: Bool) in
            NowPlaying(app: app, title: "Song", artist: "Artist", album: "Album", isPlaying: playing)
        }
        let state: MusicPlayerState =
            switch shape {
            case .closed: MusicPlayerState(running: false)
            case .notInstalled: MusicPlayerState(installed: false)
            case .empty: MusicPlayerState(running: true, access: .granted)
            case .paused: MusicPlayerState(running: true, access: .granted, nowPlaying: track(false))
            case .playing: MusicPlayerState(running: true, access: .granted, nowPlaying: track(true))
            }
        return Player(app: app, name: app, state: state)
    }

    /// The choice after each set of states in turn, as the store notes them.
    private func choice(after steps: [[Player]]) -> MusicChoice {
        steps.reduce(MusicChoice()) { $0.noting($1) }
    }

    private func pick(_ players: [Player], after steps: [[Player]] = [], pinned: MusicPin = .automatic) -> String? {
        choice(after: steps + [players]).pick(players, pinned: pinned)
    }

    // MARK: Automatic

    func testTheOnePlayingWins() {
        XCTAssertEqual(pick([player(Self.spotify, .paused), player(Self.music, .playing)]), Self.music)
        XCTAssertEqual(pick([player(Self.spotify, .playing), player(Self.music, .paused)]), Self.spotify)
        XCTAssertEqual(pick([player(Self.spotify, .empty), player(Self.music, .playing)]), Self.music)
    }

    func testOfTwoPlayingTheOneThatStartedLastWins() {
        let musicFirst = [player(Self.spotify, .paused), player(Self.music, .playing)]
        let both = [player(Self.spotify, .playing), player(Self.music, .playing)]
        XCTAssertEqual(pick(both, after: [musicFirst]), Self.spotify)
        let spotifyFirst = [player(Self.spotify, .playing), player(Self.music, .paused)]
        XCTAssertEqual(pick(both, after: [spotifyFirst]), Self.music)
        // Both at once: the store's order.
        XCTAssertEqual(pick(both), Self.spotify)
    }

    func testAPlayerThatPlaysAgainStartsAnew() {
        let both = [player(Self.spotify, .playing), player(Self.music, .playing)]
        let spotifyPaused = [player(Self.spotify, .paused), player(Self.music, .playing)]
        // Music started last, then Spotify paused and played again: Spotify is now the last one started.
        let steps = [[player(Self.spotify, .playing), player(Self.music, .paused)], both, spotifyPaused]
        XCTAssertEqual(pick(both, after: steps), Self.spotify)
    }

    func testWithNonePlayingTheLastOneThatPlayedWins() {
        let bothPaused = [player(Self.spotify, .paused), player(Self.music, .paused)]
        XCTAssertEqual(pick(bothPaused, after: [[player(Self.spotify, .paused), player(Self.music, .playing)]]), Self.music)
        XCTAssertEqual(pick(bothPaused, after: [[player(Self.spotify, .playing), player(Self.music, .paused)]]), Self.spotify)
        // Even with nothing loaded any more, while it runs.
        let musicEmpty = [player(Self.spotify, .paused), player(Self.music, .empty)]
        XCTAssertEqual(pick(musicEmpty, after: [[player(Self.spotify, .paused), player(Self.music, .playing)]]), Self.music)
    }

    func testTheLastOneThatPlayedQuit() {
        let played = [[player(Self.spotify, .paused), player(Self.music, .playing)]]
        // Then one with a track, then one that runs.
        XCTAssertEqual(pick([player(Self.spotify, .paused), player(Self.music, .closed)], after: played), Self.spotify)
        XCTAssertEqual(pick([player(Self.spotify, .empty), player(Self.music, .closed)], after: played), Self.spotify)
        XCTAssertEqual(
            pick([player(Self.spotify, .empty), player(Self.music, .closed), player(Self.deezer, .paused)], after: played), Self.deezer)
        // The last that played is remembered until another plays.
        XCTAssertEqual(choice(after: played + [[player(Self.spotify, .paused), player(Self.music, .closed)]]).lastPlayed, Self.music)
    }

    func testNeverPlayed() {
        XCTAssertEqual(pick([player(Self.spotify, .empty), player(Self.music, .paused)]), Self.music)
        XCTAssertEqual(pick([player(Self.spotify, .closed), player(Self.music, .empty)]), Self.music)
        XCTAssertEqual(pick([player(Self.spotify, .empty), player(Self.music, .empty)]), Self.spotify)
    }

    func testARunningPlayerThatIsNotAllowedStillShows() {
        let denied = Player(app: Self.spotify, name: "Spotify", state: MusicPlayerState(running: true, access: .denied))
        // The view says how to allow it.
        XCTAssertEqual(pick([denied, player(Self.music, .closed)]), Self.spotify)
        XCTAssertEqual(pick([denied, player(Self.music, .paused)]), Self.music)
    }

    func testNothingRuns() {
        XCTAssertNil(pick([]))
        XCTAssertNil(pick([player(Self.spotify, .closed), player(Self.music, .closed)]))
        XCTAssertNil(pick([player(Self.spotify, .notInstalled), player(Self.music, .closed)]))
        // A closed player's track doesn't count, nor does the one that played before it quit.
        let closedWithTrack = MusicChoice.Player(
            app: Self.music, name: "Apple Music",
            state: MusicPlayerState(
                running: false, nowPlaying: NowPlaying(app: Self.music, title: "", artist: "", album: "", isPlaying: true)))
        XCTAssertFalse(closedWithTrack.isPlaying)
        XCTAssertNil(pick([player(Self.spotify, .closed), closedWithTrack], after: [[player(Self.spotify, .playing)]]))
    }

    func testAnyNumberOfPlayers() {
        let players = [player(Self.spotify, .paused), player(Self.music, .paused), player(Self.deezer, .playing)]
        XCTAssertEqual(pick(players), Self.deezer)
        XCTAssertEqual(MusicChoice().noting(players).playing, [Self.deezer])
        let all = [player(Self.spotify, .playing), player(Self.music, .playing), player(Self.deezer, .playing)]
        XCTAssertEqual(choice(after: [players, all]).playing, [Self.deezer, Self.music, Self.spotify])
    }

    // MARK: Pinned

    func testAPinnedPlayerAlwaysWins() {
        let players = [player(Self.spotify, .paused), player(Self.music, .playing)]
        XCTAssertEqual(pick(players, pinned: .player(Self.spotify)), Self.spotify)
        // Even closed or not installed: the view then says so, and offers to open it.
        XCTAssertEqual(pick([player(Self.spotify, .closed), player(Self.music, .playing)], pinned: .player(Self.spotify)), Self.spotify)
        XCTAssertEqual(
            pick([player(Self.spotify, .notInstalled), player(Self.music, .playing)], pinned: .player(Self.spotify)), Self.spotify)
        XCTAssertEqual(pick(players, pinned: .automatic), Self.music)
    }

    func testAPinToAnAppNoPlayerIsFallsBackToAutomatic() {
        let players = [player(Self.spotify, .paused), player(Self.music, .playing)]
        XCTAssertEqual(pick(players, pinned: .player(Self.deezer)), Self.music)
        XCTAssertNil(pick([player(Self.spotify, .closed)], pinned: .player(Self.deezer)))
    }

    func testThePinIsKeptByBundleId() {
        XCTAssertEqual(MusicPin(rawValue: ""), .automatic)
        XCTAssertEqual(MusicPin(rawValue: Self.music), .player(Self.music))
        XCTAssertEqual(MusicPin.automatic.rawValue, "")
        XCTAssertEqual(MusicPin.player(Self.spotify).rawValue, Self.spotify)
        for pin in [MusicPin.automatic, .player(Self.spotify), .player(Self.music)] {
            XCTAssertEqual(MusicPin(rawValue: pin.rawValue), pin)
        }
    }

    // MARK: Nothing shown

    func testTheViewOffersThePlayersOnThisMac() {
        let players = [player(Self.spotify, .notInstalled), player(Self.music, .closed), player(Self.deezer, .empty)]
        XCTAssertEqual(MusicChoice.openable(players).map(\.app), [Self.music])
    }
}
