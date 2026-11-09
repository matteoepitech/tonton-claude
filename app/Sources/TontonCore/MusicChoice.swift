import Foundation

/// Which player the music view shows when this Mac has several: Spotify, Apple Music, the system's Now Playing. Players are
/// known by their `app`, the bundle id, in the order `MusicStore` lists them, which breaks the ties.
///
/// A player pinned in Settings › Notch always wins. Otherwise the one playing wins, and of two playing at once, the one that
/// started last. With none playing, the last one that played, while it still runs; then one with a track loaded, then one
/// that runs. With none running and none pinned, none: the view offers to open them.
public struct MusicChoice: Equatable, Sendable {
    /// A player as the choice and the music view see it.
    public struct Player: Equatable, Sendable {
        /// Its bundle id, `MusicPlayer.app`.
        public let app: String
        /// Its name as the notch writes it, `MusicPlayer.name`.
        public let name: String
        public let state: MusicPlayerState

        public init(app: String, name: String, state: MusicPlayerState) {
            self.app = app
            self.name = name
            self.state = state
        }

        public var isPlaying: Bool { state.running && state.nowPlaying?.isPlaying == true }
    }

    /// The players playing, by `app`, in the order they started: the last one started last.
    public let playing: [String]
    /// The last player that played. It stays once it pauses, to show while none plays.
    public let lastPlayed: String?

    public init(playing: [String] = [], lastPlayed: String? = nil) {
        self.playing = playing
        self.lastPlayed = lastPlayed
    }

    /// The choice once a player's state changed: those still playing keep their place, and those that just started come
    /// after them. Of players that start together, the first in the store's order counts as the last one started.
    public func noting(_ players: [Player]) -> MusicChoice {
        let now = players.filter(\.isPlaying).map(\.app)
        let kept = playing.filter(now.contains)
        let order = kept + now.filter { !kept.contains($0) }.reversed()
        return MusicChoice(playing: order, lastPlayed: order.last ?? lastPlayed)
    }

    /// The `app` of the player to show, nil for none. A pin to an app none of `players` is falls back to the automatic
    /// choice: the Now Playing player only is a given app while that app plays.
    public func pick(_ players: [Player], pinned: MusicPin) -> String? {
        func find(_ app: String?) -> Player? { app.flatMap { app in players.first { $0.app == app } } }
        if case .player(let app) = pinned, let player = find(app) { return player.app }
        let playingNow = players.filter(\.isPlaying).map(\.app)
        if let latest = playing.last(where: playingNow.contains) ?? playingNow.first { return latest }
        if let last = find(lastPlayed), last.state.running { return last.app }
        let loaded = players.first { $0.state.running && $0.state.nowPlaying != nil }
        return (loaded ?? players.first { $0.state.running })?.app
    }

    /// Another player runs beside the one shown: the view then says which one it shows.
    public static func namesPlayer(_ players: [Player]) -> Bool {
        players.filter(\.state.running).count > 1
    }

    /// The players the view offers to open while none is shown: those on this Mac that don't run.
    public static func openable(_ players: [Player]) -> [Player] {
        players.filter { $0.state.installed && !$0.state.running }
    }
}

/// The player the music view keeps to, from Settings › Notch, or none: the choice is automatic.
public enum MusicPin: Hashable, Sendable, RawRepresentable {
    case automatic
    /// By its `app`, the bundle id.
    case player(String)

    /// What the settings keep: the bundle id, empty for automatic.
    public init(rawValue: String) {
        self = rawValue.isEmpty ? .automatic : .player(rawValue)
    }

    public var rawValue: String {
        switch self {
        case .automatic: ""
        case .player(let app): app
        }
    }
}
