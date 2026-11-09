import Foundation

/// Apple Music (the Music app) on this Mac, through its AppleScript dictionary (`sdef /System/Applications/Music.app`) and
/// the notification it posts when playback changes. The scripts run in TontonMac's `AppleMusicPlayer`; what they say is
/// read here.
public enum AppleMusic {
    public static let bundleId = "com.apple.Music"
    /// Posted to the distributed notification center on play, pause, a new track and stop.
    public static let playerInfo = "com.apple.Music.playerInfo"
    /// Music posts the same change under iTunes' old name too, at the same moment and with the same userInfo.
    public static let iTunesPlayerInfo = "com.apple.iTunes.playerInfo"

    /// Between the fields of `readScript`'s answer: the unit separator, which no title holds.
    static let separator: Character = "\u{1F}"

    // Each script checks that Music runs first: a `tell` would launch it, even one sent just as it quits.
    private static let ifRunning = #"if application id "com.apple.Music" is not running then return """#

    /// The player and its current track in one line, read by `reading(from:)`. The position and the duration go out as
    /// whole milliseconds: a real number written as text takes the decimal comma of a French Mac, and AppleScript writes
    /// big ones with an exponent. The track's fields are left out when there is no current track, and the duration when
    /// it has none, as a radio stream. No variable is called `song`, a word of Music's dictionary.
    public static let readScript = """
        \(ifRunning)
        with timeout of 5 seconds
            tell application id "com.apple.Music"
                set sep to character id 31
                set out to (player state as text) & sep & (sound volume as text) & sep
                try
                    set out to out & (((player position * 1000) as integer) as text)
                end try
                set out to out & sep & (shuffle enabled as text) & sep & (song repeat as text)
                try
                    set t to current track
                    set details to sep & ((persistent ID of t) as text) & sep & ((name of t) as text) & sep & ((artist of t) as text)
                    set details to details & sep & ((album of t) as text) & sep
                    try
                        set details to details & ((((duration of t) * 1000) as integer) as text)
                    end try
                    set out to out & details
                end try
                return out
            end tell
        end timeout
        """

    /// The script that sends `command`. Previous is `back track`, as Music's own button: to the start of the track, or to
    /// the one before when already there.
    public static func script(for command: MusicCommand) -> String {
        let order =
            switch command {
            case .playPause: "playpause"
            case .nextTrack: "next track"
            case .previousTrack: "back track"
            // AppleScript reads a point whatever the Mac's language; `String(format:)` writes one.
            case .seek(let to): "set player position to \(String(format: "%.3f", max(0, to.isFinite ? to : 0)))"
            case .volume(let volume): "set sound volume to \(MusicVolume.clamp(volume))"
            }
        return """
            \(ifRunning)
            with timeout of 5 seconds
                tell application id "com.apple.Music" to \(order)
            end timeout
            return "ok"
            """
    }

    /// The cover of the track whose `persistent ID` is `trackId`, as the bytes of a picture, while it is still the current
    /// track: by the time the script runs, Music may have gone on to the next one. Nil for an id that isn't one, which
    /// never goes into a script.
    public static func artworkScript(for trackId: String) -> String? {
        guard let id = persistentId(trackId) else { return nil }
        return """
            \(ifRunning)
            with timeout of 10 seconds
                tell application id "com.apple.Music"
                    set t to current track
                    if (persistent ID of t) is not "\(id)" then return ""
                    return data of artwork 1 of t
                end tell
            end timeout
            """
    }

    /// A cover read from Music, mostly a JPEG or a PNG of a few hundred kilobytes: anything much bigger is no cover to keep.
    public static let maxArtworkBytes = 10 * 1024 * 1024

    /// What Music says, in the words of its dictionary.
    public struct Reading: Equatable, Sendable {
        public enum State: String, Sendable {
            case stopped, playing, paused
            case fastForwarding = "fast forwarding"
            case rewinding
        }

        public struct Track: Equatable, Sendable {
            /// Its `persistent ID`, which doesn't change: 16 hexadecimal digits.
            public let id: String?
            public let name: String
            public let artist: String
            public let album: String
            public let duration: TimeInterval?
        }

        public let state: State
        public let volume: Int?
        /// In seconds.
        public let position: TimeInterval?
        public let shuffling: Bool?
        public let repeating: Bool?
        public let track: Track?

        /// The music goes on while it winds forward or back.
        public var isPlaying: Bool { state != .paused && state != .stopped }

        /// What the notch shows: nothing while stopped. A reading without a position, as the notification, takes the one
        /// `previous` had come to by `date` when it is the same track. What `previous` knew that this one doesn't say, the
        /// volume first, stays.
        public func nowPlaying(at date: Date, after previous: NowPlaying? = nil) -> NowPlaying? {
            guard state != .stopped, let track else { return nil }
            let same = previous.map { $0.app == AppleMusic.bundleId && track.id != nil && $0.trackId == track.id } ?? false
            let now = NowPlaying(
                app: AppleMusic.bundleId, title: track.name, artist: track.artist, album: track.album, isPlaying: isPlaying,
                duration: track.duration, position: position ?? (same ? previous?.elapsed(at: date) : nil), positionDate: date,
                trackId: track.id, volume: volume, shuffling: shuffling, repeating: repeating)
            return now.keeping(from: previous)
        }
    }

    /// `readScript`'s answer. Nil for an empty one, which says Music doesn't run, and for anything it doesn't recognize.
    public static func reading(from output: String) -> Reading? {
        let fields = output.split(separator: separator, omittingEmptySubsequences: false).map(String.init)
        guard fields.count >= 5, let state = Reading.State(rawValue: fields[0].lowercased()) else { return nil }
        let track =
            fields.count >= 10
            ? Reading.Track(
                id: persistentId(fields[5]), name: text(fields[6]), artist: text(fields[7]), album: text(fields[8]),
                duration: seconds(milliseconds: number(fields[9])))
            : nil
        return Reading(
            state: state, volume: Int(fields[1]), position: number(fields[2]).map { $0 / 1000 }, shuffling: Bool(fields[3]),
            repeating: repeating(fields[4]), track: track)
    }

    /// The `playerInfo` notification's userInfo: the state and the track as Music's own keys name them, with its length in
    /// milliseconds. No position, no volume: `readScript` has those. Nil for anything else.
    public static func reading(fromNotification userInfo: [AnyHashable: Any]) -> Reading? {
        guard let state = (userInfo["Player State"] as? String).flatMap({ Reading.State(rawValue: $0.lowercased()) }) else {
            return nil
        }
        let id = trackId(userInfo["PersistentID"])
        let name = userInfo["Name"] as? String ?? ""
        let track =
            id == nil && name.isEmpty
            ? nil
            : Reading.Track(
                id: id, name: name, artist: userInfo["Artist"] as? String ?? "", album: userInfo["Album"] as? String ?? "",
                duration: seconds(milliseconds: double(userInfo["Total Time"])))
        return Reading(state: state, volume: nil, position: nil, shuffling: nil, repeating: nil, track: track)
    }

    /// Music posts each change twice at once, under `playerInfo` and `iTunesPlayerInfo`: the second says nothing new. True
    /// when `reading` is the last one received, come again within a second.
    public static func repeats(_ reading: Reading, at date: Date, last: Reading?, receivedAt lastDate: Date?) -> Bool {
        guard let last, let lastDate else { return false }
        return last == reading && abs(date.timeIntervalSince(lastDate)) < 1
    }

    /// The notification's `PersistentID`, a signed 64-bit number, written as AppleScript writes `persistent ID`: the 16
    /// hexadecimal digits of its bits.
    public static func trackId(_ value: Any?) -> String? {
        switch value {
        case let number as NSNumber: String(format: "%016llX", UInt64(bitPattern: number.int64Value))
        case let text as String: persistentId(text)
        default: nil
        }
    }

    /// A `persistent ID` in upper case on 16 digits, or nil for anything but hexadecimal digits: it goes into
    /// `artworkScript`.
    static func persistentId(_ text: String) -> String? {
        let id = text.trimmingCharacters(in: .whitespaces).uppercased()
        guard !id.isEmpty, id.count <= 16, id.allSatisfy({ "0123456789ABCDEF".contains($0) }) else { return nil }
        return String(repeating: "0", count: 16 - id.count) + id
    }

    /// `song repeat`: off, one or all.
    private static func repeating(_ field: String) -> Bool? {
        switch field {
        case "off": false
        case "one", "all": true
        default: nil
        }
    }

    private static func seconds(milliseconds: Double?) -> TimeInterval? {
        guard let milliseconds, milliseconds > 0 else { return nil }
        return milliseconds / 1000
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
