import Foundation

/// A music player on this Mac that the notch shows and drives in Music mode. Spotify is the first (TontonMac's
/// `SpotifyPlayer`); Apple Music and the system's Now Playing plug in the same way. What a player says stays on this Mac:
/// it never goes to the relay, and nothing about it is logged.
@MainActor
public protocol MusicPlayer: AnyObject {
    /// The player's bundle id, the one its `NowPlaying.app` gives.
    var app: String { get }
    /// Its name as the notch writes it.
    var name: String { get }
    var state: MusicPlayerState { get }
    /// Called on the main actor each time `state` changes.
    var onChange: ((MusicPlayerState) -> Void)? { get set }
    /// Starts following the player: the first moment it may ask for the Automation permission and send Apple Events.
    /// Calling it again does nothing.
    func start()
    /// Reads the player again, now. Nothing while it doesn't run.
    func refresh()
    func perform(_ command: MusicCommand)
    /// The cover of `track` as image bytes, however the player gives it: Spotify by an address on its image server, other
    /// players in the bytes themselves. Nil when there is none or it can't be had.
    func artwork(for track: NowPlaying) async -> Data?
    /// Brings the player to the front.
    func activate()
    /// Opens the player, when it is installed.
    func launch()
}

/// What the notch's controls ask a player to do.
public enum MusicCommand: Equatable, Sendable {
    case playPause
    case nextTrack
    case previousTrack
    /// To this point of the track, in seconds.
    case seek(TimeInterval)
    /// The player's own volume, from 0 to 100.
    case volume(Int)
}

/// Whether macOS lets Tonton send a player Apple Events: System Settings › Privacy & Security › Automation.
public enum MusicAccess: Equatable, Sendable {
    /// Not known yet: not asked, or asked while the player was not running.
    case unknown
    case granted
    case denied

    /// What `AEDeterminePermissionToAutomateTarget` answered. Not running (procNotFound) and anything else leave it unknown,
    /// to ask again later.
    public init(automationStatus status: Int32) {
        switch status {
        case 0: self = .granted
        // errAEEventNotPermitted, and errAEEventWouldRequireUserConsent when it was not allowed to ask.
        case -1743, -1744: self = .denied
        default: self = .unknown
        }
    }

    /// The error an Apple Event fails with when the user turned the permission off.
    public static let notPermittedError = -1743
}

/// A player as the notch knows it.
public struct MusicPlayerState: Equatable, Sendable {
    public var installed: Bool
    public var running: Bool
    public var access: MusicAccess
    /// What it plays. Nil when it is stopped, not read yet, or not running.
    public var nowPlaying: NowPlaying?

    public init(installed: Bool = true, running: Bool = false, access: MusicAccess = .unknown, nowPlaying: NowPlaying? = nil) {
        self.installed = installed
        self.running = running
        self.access = access
        self.nowPlaying = nowPlaying
    }

    /// What the music view shows.
    public var screen: MusicScreen {
        if !running { return installed ? .notRunning : .notInstalled }
        switch access {
        case .denied: return .denied
        case .unknown: return .waiting
        case .granted: return nowPlaying.map(MusicScreen.playing) ?? .nothing
        }
    }
}

public enum MusicScreen: Equatable, Sendable {
    case notInstalled
    /// A button opens the player.
    case notRunning
    /// The Automation permission was refused: a button opens System Settings.
    case denied
    /// macOS is asking, or the first read is on its way.
    case waiting
    /// The player runs with nothing loaded.
    case nothing
    case playing(NowPlaying)
}

extension NowPlaying {
    /// Where the track is at `date`: the position read, plus the time since while it plays, within the track.
    public func elapsed(at date: Date) -> TimeInterval? {
        guard let position else { return nil }
        let elapsed = isPlaying ? position + max(0, date.timeIntervalSince(positionDate)) : position
        return min(max(0, elapsed), duration ?? .infinity)
    }

    /// From 0 to 1, nil without a duration.
    public func progress(at date: Date) -> Double? {
        guard let duration, duration > 0, let elapsed = elapsed(at: date) else { return nil }
        return elapsed / duration
    }

    /// What the command will make of it, shown before the player answers. Skipping waits for the player: the next track
    /// is not known yet.
    public func applying(_ command: MusicCommand, at date: Date) -> NowPlaying {
        switch command {
        case .playPause: with(isPlaying: !isPlaying, position: elapsed(at: date), positionDate: date)
        case .seek(let to): with(position: min(max(0, to), duration ?? .infinity), positionDate: date)
        case .volume(let volume): with(volume: MusicVolume.clamp(volume))
        case .nextTrack, .previousTrack: self
        }
    }

    /// A newer reading, keeping what this one knew that it doesn't say: Spotify's notification has no volume and no
    /// cover, which the last read of the same track had.
    public func keeping(from previous: NowPlaying?) -> NowPlaying {
        guard let previous, previous.app == app else { return self }
        return with(
            artworkURL: isSameTrack(as: previous) ? previous.artworkURL : nil, volume: previous.volume, shuffling: previous.shuffling,
            repeating: previous.repeating, onlyWhereMissing: true)
    }

    /// What tells one cover from another, to keep each once downloaded: its address when the player gives one, which the
    /// tracks of an album share, else the track.
    public var artworkKey: String {
        artworkURL?.absoluteString ?? [app, trackId ?? "", title, artist, album].joined(separator: "\u{1F}")
    }

    /// By the player's id when both have one, else by what the notch shows.
    public func isSameTrack(as other: NowPlaying) -> Bool {
        if let id = trackId, let otherId = other.trackId { return id == otherId }
        return title == other.title && artist == other.artist && album == other.album
    }

    /// A copy with the values given in place of its own, or only where it has none. The track stays the same.
    private func with(
        isPlaying: Bool? = nil, position: TimeInterval? = nil, positionDate: Date? = nil, artworkURL: URL? = nil, volume: Int? = nil,
        shuffling: Bool? = nil, repeating: Bool? = nil, onlyWhereMissing: Bool = false
    ) -> NowPlaying {
        func pick<Value>(_ own: Value?, _ given: Value?) -> Value? { onlyWhereMissing ? own ?? given : given ?? own }
        return NowPlaying(
            app: app, title: title, artist: artist, album: album, isPlaying: isPlaying ?? self.isPlaying, duration: duration,
            position: pick(self.position, position), positionDate: positionDate ?? self.positionDate, trackId: trackId,
            artworkURL: pick(self.artworkURL, artworkURL), volume: pick(self.volume, volume), shuffling: pick(self.shuffling, shuffling),
            repeating: pick(self.repeating, repeating))
    }
}

public enum MusicVolume {
    public static func clamp(_ volume: Int) -> Int { min(max(0, volume), 100) }
}

/// Minutes and seconds, as players write a track's time: `3:07`, `1:02:45` past an hour.
public enum TrackTime {
    public static func text(_ seconds: TimeInterval) -> String {
        let total = seconds.isFinite ? max(0, Int(seconds.rounded(.down))) : 0
        let (hours, minutes, rest) = (total / 3600, total / 60 % 60, total % 60)
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }
}
