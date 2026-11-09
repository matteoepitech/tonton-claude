import Foundation

/// macOS's Now Playing, what Control Center shows, read through mediaremote-adapter (app/Vendor/mediaremote-adapter).
/// Since macOS 15.4 MediaRemote answers only Apple's own processes: the adapter is a framework that `/usr/bin/perl` loads,
/// and perl is one of those. TontonMac's `NowPlayingPlayer` runs it; what it says is read here.
public enum MediaRemoteAdapter {
    /// `stream`'s options: times in microseconds (its plain `timestamp` keeps only whole seconds), items without a title
    /// (the app's name shows in its place), and a tenth of a second for a new track's fields to arrive together.
    public static let streamArguments = ["stream", "--micros", "--allow-missing-title", "--debounce=100"]

    /// What the adapter is told to do for `command`, with MediaRemote's command ids from its MediaRemoteAdapter.h. Nil for
    /// the volume: Now Playing has none.
    public static func arguments(for command: MusicCommand) -> [String]? {
        switch command {
        case .playPause: ["send", "2"]  // kMRATogglePlayPause
        case .nextTrack: ["send", "4"]  // kMRANextTrack
        case .previousTrack: ["send", "5"]  // kMRAPreviousTrack
        // In whole microseconds.
        case .seek(let to): ["seek", String(Int64((max(0, to.isFinite ? to : 0) * 1_000_000).rounded()))]
        case .volume: nil
        }
    }

    /// The players the notch reads through their own scripts, which say more (the volume, Spotify's covers): Now Playing
    /// shows nothing while one of them is its app.
    public static let ownPlayers: Set<String> = [Spotify.bundleId, "com.apple.Music"]
}

/// What the adapter's `stream` said so far. It writes one JSON object a line, `{"type":"data","diff":false,"payload":{…}}`
/// (stream.m, v0.7.7). A payload that is no diff holds all that is known, and an empty one says nothing plays. A diff holds
/// what changed for the same item, null for what is gone: the app, the title, the artist and the album never change in one.
public struct NowPlayingFeed: Equatable, Sendable {
    /// A value of the payload. Lists and objects, which no key read here holds, are `other`.
    public enum Value: Equatable, Sendable, Decodable {
        case text(String)
        case number(Double)
        case flag(Bool)
        case other

        public init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let flag = try? container.decode(Bool.self) {
                self = .flag(flag)
            } else if let number = try? container.decode(Double.self) {
                self = .number(number)
            } else if let text = try? container.decode(String.self) {
                self = .text(text)
            } else {
                self = .other
            }
        }
    }

    public private(set) var payload: [String: Value] = [:]

    /// A cover as base64 is a third bigger than its bytes; anything past this is no cover.
    static let maxArtworkCharacters = 16 * 1024 * 1024

    public init() {}

    private struct Line: Decodable {
        let type: String
        let diff: Bool?
        let payload: [String: Value?]?
    }

    /// Takes one line of the stream, and gives the keys it changed. Nil for a line that is not one of its data lines, which
    /// leaves the feed as it was: later versions may write other kinds.
    @discardableResult
    public mutating func apply(_ line: Data) -> Set<String>? {
        guard let line = try? JSONDecoder().decode(Line.self, from: line), line.type == "data" else { return nil }
        var next = line.diff == true ? payload : [:]
        // A null removes the key.
        for (key, value) in line.payload ?? [:] { next[key] = value }
        let changed = Set(payload.keys).union(next.keys).filter { payload[$0] != next[$0] }
        payload = next
        return changed
    }

    /// Nothing plays, or the adapter has said nothing yet.
    public var isEmpty: Bool { payload.isEmpty }

    public var bundleId: String? { text("bundleIdentifier") }
    /// The app a web player plays in, when MediaRemote knows it: Safari for its WebKit process.
    public var parentBundleId: String? { text("parentApplicationBundleIdentifier") }

    /// The app the notch names. A process with no bundle, a command-line tool, has none.
    public var app: String? { parentBundleId ?? bundleId }

    /// Spotify or Apple Music is the app of Now Playing.
    public var isOwnPlayer: Bool {
        [bundleId, parentBundleId].contains { $0.map(MediaRemoteAdapter.ownPlayers.contains) ?? false }
    }

    public var isPlaying: Bool {
        switch payload["playing"] {
        case .flag(let playing): playing
        case .number(let playing): playing != 0
        default: false
        }
    }

    public var title: String { text("title") ?? "" }
    public var artist: String { text("artist") ?? "" }
    public var album: String { text("album") ?? "" }
    public var duration: TimeInterval? { seconds("durationMicros").flatMap { $0 > 0 ? $0 : nil } }
    /// Where the track was at `positionDate`.
    public var position: TimeInterval? { seconds("elapsedTimeMicros").map { max(0, $0) } }
    public var positionDate: Date? { seconds("timestampEpochMicros").map(Date.init(timeIntervalSince1970:)) }
    /// MediaRemote's id for the item, when the player gives one.
    public var trackId: String? { text("contentItemIdentifier") ?? text("uniqueIdentifier") }
    /// MediaRemote's modes: 1 is off, 2 and 3 are on (albums or tracks, a track or the list).
    public var shuffling: Bool? { mode("shuffleMode") }
    public var repeating: Bool? { mode("repeatMode") }

    /// The cover's bytes, in whatever format the player gave them.
    public var artwork: Data? {
        guard let text = text("artworkData"), text.count <= Self.maxArtworkCharacters else { return nil }
        return Data(base64Encoded: text, options: .ignoreUnknownCharacters).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// What the notch shows: nil while nothing plays, while Spotify or Apple Music is the app of Now Playing, and for a
    /// process with no app. `date` stands for when the position was read if the adapter didn't say.
    public func nowPlaying(at date: Date) -> NowPlaying? {
        guard !isEmpty, !isOwnPlayer, let app else { return nil }
        return NowPlaying(
            app: app, title: title, artist: artist, album: album, isPlaying: isPlaying, duration: duration, position: position,
            positionDate: positionDate ?? date, trackId: trackId, shuffling: shuffling, repeating: repeating)
    }

    private func text(_ key: String) -> String? {
        guard case .text(let text) = payload[key], !text.isEmpty else { return nil }
        return text
    }

    private func seconds(_ key: String) -> TimeInterval? {
        guard case .number(let micros) = payload[key], micros.isFinite else { return nil }
        return micros / 1_000_000
    }

    private func mode(_ key: String) -> Bool? {
        guard case .number(let mode) = payload[key] else { return nil }
        switch mode {
        case 1: return false
        case 2, 3: return true
        default: return nil
        }
    }
}

/// When to start the adapter again after it stopped by itself: a second later the first time, twice as long each time
/// after, up to five minutes. A run of a minute or more was a good one, and the count starts again.
public struct AdapterRestarts: Equatable, Sendable {
    public static let goodRun: TimeInterval = 60
    public static let maxDelay: TimeInterval = 300
    /// This many short runs in a row, and the notch stops counting on it: the media keys take over until it runs well.
    public static let failingAfter = 3

    public private(set) var failures = 0

    public init() {}

    /// The delay before the next start, for a run that lasted `ran` seconds.
    public mutating func stopped(afterRunning ran: TimeInterval) -> TimeInterval {
        if ran >= Self.goodRun { failures = 0 }
        failures += 1
        return min(Self.maxDelay, pow(2, Double(min(failures, 10) - 1)))
    }

    public var failing: Bool { failures >= Self.failingAfter }
}

/// Splits what a child process writes into lines. A line past `maxLength` is dropped whole: the adapter's longest carry a
/// cover, a few hundred kilobytes.
public struct LineBuffer: Sendable {
    public let maxLength: Int
    private var pending = Data()
    private var overflowing = false

    public init(maxLength: Int = 24 * 1024 * 1024) { self.maxLength = maxLength }

    /// The lines `chunk` completes, without their newline. Empty ones are skipped.
    public mutating func append(_ chunk: Data) -> [Data] {
        var lines: [Data] = []
        var rest = chunk[...]
        while let newline = rest.firstIndex(of: 0x0A) {
            if !overflowing { pending.append(rest[..<newline]) }
            if !overflowing, pending.count <= maxLength, !pending.isEmpty { lines.append(pending) }
            pending = Data()
            overflowing = false
            rest = rest[rest.index(after: newline)...]
        }
        if !overflowing { pending.append(rest) }
        if pending.count > maxLength {
            pending = Data()
            overflowing = true
        }
        return lines
    }
}
