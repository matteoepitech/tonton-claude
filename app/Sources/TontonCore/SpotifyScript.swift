import Foundation

/// Spotify on this Mac, through its AppleScript dictionary (`sdef /Applications/Spotify.app`) and the notification it posts
/// when playback changes. The scripts run in TontonMac's `SpotifyPlayer`; what they say is read here.
public enum Spotify {
    public static let bundleId = "com.spotify.client"
    /// Posted to the distributed notification center on play, pause, a new track and quit.
    public static let playbackChanged = "com.spotify.client.PlaybackStateChanged"

    /// Between the fields of `readScript`'s answer: the unit separator, which no title holds.
    static let separator: Character = "\u{1F}"

    // Each script checks that Spotify runs first: a `tell` would launch it, even one sent just as it quits.
    private static let ifRunning = #"if application id "com.spotify.client" is not running then return """#

    /// The player and its current track in one line, read by `reading(from:)`. The position goes out as whole
    /// milliseconds: a real number written as text takes the decimal comma of a French Mac. The track's fields are left
    /// out when Spotify has none, as when it has just opened.
    public static let readScript = """
        \(ifRunning)
        with timeout of 5 seconds
            tell application id "com.spotify.client"
                set sep to character id 31
                set out to (player state as text) & sep & (sound volume as text) & sep
                try
                    set out to out & (((player position * 1000) as integer) as text)
                end try
                set out to out & sep & (shuffling as text) & sep & (repeating as text)
                try
                    set t to current track
                    set song to sep & ((id of t) as text) & sep & ((name of t) as text) & sep & ((artist of t) as text)
                    set song to song & sep & ((album of t) as text) & sep & ((duration of t) as text) & sep & ((artwork url of t) as text)
                    set out to out & song
                end try
                return out
            end tell
        end timeout
        """

    /// The script that sends `command`.
    public static func script(for command: MusicCommand) -> String {
        let order =
            switch command {
            case .playPause: "playpause"
            case .nextTrack: "next track"
            case .previousTrack: "previous track"
            // AppleScript reads a point whatever the Mac's language; `String(format:)` writes one.
            case .seek(let to): "set player position to \(String(format: "%.3f", max(0, to.isFinite ? to : 0)))"
            case .volume(let volume): "set sound volume to \(MusicVolume.clamp(volume))"
            }
        return """
            \(ifRunning)
            with timeout of 5 seconds
                tell application id "com.spotify.client" to \(order)
            end timeout
            return "ok"
            """
    }

    /// What Spotify says, in the words of its dictionary.
    public struct Reading: Equatable, Sendable {
        public enum State: String, Sendable { case stopped, playing, paused }

        public struct Track: Equatable, Sendable {
            /// `spotify:track:…`, `spotify:local:…` for a file, `spotify:ad:…`.
            public let id: String
            public let name: String
            public let artist: String
            public let album: String
            public let duration: TimeInterval?
            public let artworkURL: URL?
        }

        public let state: State
        public let volume: Int?
        /// In seconds.
        public let position: TimeInterval?
        public let shuffling: Bool?
        public let repeating: Bool?
        public let track: Track?

        /// What the notch shows: nothing while stopped.
        public func nowPlaying(at date: Date) -> NowPlaying? {
            guard state != .stopped, let track else { return nil }
            return NowPlaying(
                app: Spotify.bundleId, title: track.name, artist: track.artist, album: track.album, isPlaying: state == .playing,
                duration: track.duration, position: position, positionDate: date, trackId: track.id, artworkURL: track.artworkURL,
                volume: volume, shuffling: shuffling, repeating: repeating)
        }
    }

    /// `readScript`'s answer. Nil for an empty one, which says Spotify doesn't run, and for anything it doesn't recognize.
    public static func reading(from output: String) -> Reading? {
        let fields = output.split(separator: separator, omittingEmptySubsequences: false).map(String.init)
        guard fields.count >= 5, let state = Reading.State(rawValue: fields[0].lowercased()) else { return nil }
        let track =
            fields.count >= 11 && !fields[5].isEmpty
            ? Reading.Track(
                id: fields[5], name: text(fields[6]), artist: text(fields[7]), album: text(fields[8]),
                duration: trackLength(number(fields[9])), artworkURL: artworkURL(fields[10]))
            : nil
        return Reading(
            state: state, volume: Int(fields[1]), position: number(fields[2]).map { $0 / 1000 }, shuffling: Bool(fields[3]),
            repeating: Bool(fields[4]), track: track)
    }

    /// The `playbackChanged` notification's userInfo: the state and the track as Spotify's own keys name them, with its
    /// position in seconds. No volume and no cover: `readScript` has those. Nil for anything else.
    public static func reading(fromNotification userInfo: [AnyHashable: Any]) -> Reading? {
        guard let state = (userInfo["Player State"] as? String).flatMap({ Reading.State(rawValue: $0.lowercased()) }) else {
            return nil
        }
        let id = userInfo["Track ID"] as? String ?? ""
        let track =
            id.isEmpty
            ? nil
            : Reading.Track(
                id: id, name: userInfo["Name"] as? String ?? "", artist: userInfo["Artist"] as? String ?? "",
                album: userInfo["Album"] as? String ?? "", duration: trackLength(double(userInfo["Duration"])),
                artworkURL: nil)
        return Reading(
            state: state, volume: nil, position: double(userInfo["Playback Position"]), shuffling: nil, repeating: nil, track: track)
    }

    /// The covers Spotify serves itself, over HTTPS: the only ones the notch downloads.
    public static func artworkURL(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespaces)), url.scheme == "https", let host = url.host?.lowercased()
        else { return nil }
        let spotify = ["scdn.co", "spotifycdn.com"].contains { host == $0 || host.hasSuffix(".\($0)") }
        return spotify ? url : nil
    }

    /// A track's length in seconds. Spotify's dictionary says seconds, its AppleScript gives milliseconds, and its
    /// notification has given both over the years: no track lasts ten hours, so a bigger number is milliseconds. A
    /// track under 36 seconds given in milliseconds reads as hours: the bar then hardly moves.
    static func trackLength(_ value: Double?) -> TimeInterval? {
        guard let value, value > 0 else { return nil }
        return value > 36_000 ? value / 1000 : value
    }

    /// AppleScript writes a missing value as these words.
    private static func text(_ field: String) -> String { field == "missing value" ? "" : field }

    private static func number(_ field: String) -> Double? {
        Double(field.replacingOccurrences(of: ",", with: ".")).flatMap { $0.isFinite ? $0 : nil }
    }

    private static func double(_ value: Any?) -> Double? {
        switch value {
        case let number as NSNumber: number.doubleValue.isFinite ? number.doubleValue : nil
        case let text as String: number(text)
        default: nil
        }
    }
}
