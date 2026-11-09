import Foundation

/// What the notch falls back on when Now Playing can't be read: which app plays sound, from Core Audio's list of its
/// clients, and the media keys of the keyboard for the controls. TontonMac reads the list and posts the keys; what they
/// mean is here.

/// A key of the keyboard's media row, as a program posts it: an event of type `systemDefined` and subtype 8
/// (`NX_SUBTYPE_AUX_CONTROL_BUTTONS`, IOKit/hidsystem/IOLLEvent.h), with the key (ev_keymap.h) and its state in `data1`.
/// It goes to the app macOS holds for Now Playing.
public enum MediaKey: Int, Equatable, Sendable {
    case playPause = 16  // NX_KEYTYPE_PLAY
    case next = 17  // NX_KEYTYPE_NEXT
    case previous = 18  // NX_KEYTYPE_PREVIOUS

    public static let subtype: Int16 = 8

    /// The key for `command`. None for a seek or the volume: the keys have no such thing.
    public init?(_ command: MusicCommand) {
        switch command {
        case .playPause: self = .playPause
        case .nextTrack: self = .next
        case .previousTrack: self = .previous
        case .seek, .volume: return nil
        }
    }

    /// The modifier flags and the low half of `data1`: 0xA00 as the key goes down, 0xB00 as it comes up.
    public static func state(down: Bool) -> Int { down ? 0xA00 : 0xB00 }

    public func data1(down: Bool) -> Int { rawValue << 16 | Self.state(down: down) }
}

/// Which app plays sound, for the notch to show when Now Playing says nothing. Only an app that has played for a few
/// seconds shows, so that a notification's sound doesn't; one that also records is left out, a call. Once it stops, it
/// stays as paused while it runs, for the play button to resume it.
public struct SoundingApps: Equatable, Sendable {
    /// A client of Core Audio: a process that has opened an audio device.
    public struct Client: Equatable, Sendable {
        /// The bundle id of the app the process belongs to: a browser for its helper. Nil for a process outside an app.
        public let app: String?
        public let output: Bool
        public let input: Bool

        public init(app: String?, output: Bool, input: Bool = false) {
            self.app = app
            self.output = output
            self.input = input
        }
    }

    public struct Shown: Equatable, Sendable {
        public let app: String
        public let sounding: Bool
    }

    /// How long an app plays before it shows.
    public static let hold: TimeInterval = 3
    /// How long an app plays while Now Playing stays empty before the notch decides it can't read Now Playing.
    public static let blindAfter: TimeInterval = 10

    public private(set) var shown: Shown?
    /// When each app that plays now began to.
    private var since: [String: Date] = [:]
    private let excluded: Set<String>

    /// `excluded`: apps that have their own way in (Spotify, Apple Music), and Tonton itself.
    public init(excluding excluded: Set<String>) { self.excluded = excluded }

    /// Takes the clients Core Audio lists now. Gives when to look again, as an app will have played long enough by then.
    public mutating func update(_ clients: [Client], at date: Date) -> Date? {
        let playing = Set(clients.filter { $0.output && !$0.input }.compactMap(\.app)).subtracting(excluded)
        since = since.filter { playing.contains($0.key) }
        for app in playing where since[app] == nil { since[app] = date }
        // The app shown plays again at once when it resumes.
        let held = since.filter { $0.key == shown?.app || date.timeIntervalSince($0.value) >= Self.hold }
        if let latest = held.max(by: { $0.value < $1.value }) {
            shown = Shown(app: latest.key, sounding: true)
        } else if let shown, clients.contains(where: { $0.app == shown.app }) {
            self.shown = Shown(app: shown.app, sounding: false)
        } else {
            shown = nil
        }
        return since.values.flatMap { [$0 + Self.hold, $0 + Self.blindAfter] }.filter { $0 > date }.min()
    }

    /// An app has played for `blindAfter`: while Now Playing still says nothing, the adapter doesn't see it.
    public func playedLong(at date: Date) -> Bool {
        since.values.contains { date.timeIntervalSince($0) >= Self.blindAfter }
    }

    /// The app a process belongs to, from its executable's path: the outermost `.app`, so that a browser's helper deep in
    /// its bundle counts as the browser. Nil outside an app, as for Safari's WebKit processes in /System/Library.
    public static func outermostApp(_ path: String) -> String? {
        var app = ""
        for component in path.split(separator: "/", omittingEmptySubsequences: true) {
            app += "/" + component
            if component.hasSuffix(".app") { return app }
        }
        return nil
    }
}
