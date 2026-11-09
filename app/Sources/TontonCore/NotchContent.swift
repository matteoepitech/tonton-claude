import Foundation

/// What the notch is about: the sessions, or the music playing on this Mac. The switch at the top of the open notch, the
/// command palette and ⌘M pick it, and the settings keep it.
public enum NotchContent: String, CaseIterable, Sendable {
    case sessions, music

    /// The one that doesn't show, for ⌘M and the palette.
    public var other: NotchContent { self == .sessions ? .music : .sessions }

    /// In Music mode the collapsed notch keeps to the music, but a session that needs the user still gets through: a
    /// permission, a question or an error, or a session that finished since the user last saw the sessions.
    public static func breaksThrough(_ session: SessionSummary, finishedUnseen: Set<String>) -> Bool {
        session.status.needsAttention || (session.status == .idle && finishedUnseen.contains(session.id))
    }

    /// The sessions that keep their pill under the collapsed notch, in the order given.
    public func pills(_ sessions: [SessionSummary], finishedUnseen: Set<String>) -> [SessionSummary] {
        switch self {
        case .sessions: sessions
        case .music: sessions.filter { Self.breaksThrough($0, finishedUnseen: finishedUnseen) }
        }
    }

    /// Players may be asked what they play, which sends them Apple Events and can show the user an Automation prompt: only
    /// once the user opened Music mode, never before.
    public static func listensToPlayers(musicOpened: Bool, showing: NotchContent?) -> Bool {
        musicOpened || showing == .music
    }
}

/// What the open notch shows. The user's choice is saved. Opening a session from Music mode (its pill, its banner, a
/// permission that opens the notch, the palette, ⌘1…9) shows the sessions until the notch closes, and leaves the choice as
/// it was: a permission to answer must not take the music away for good.
public struct NotchContentChoice: Equatable, Sendable {
    public let saved: NotchContent
    /// The sessions show over a saved Music, until the notch closes.
    public let visiting: Bool

    public init(saved: NotchContent, visiting: Bool = false) {
        self.saved = saved
        self.visiting = visiting && saved == .music
    }

    public var shown: NotchContent { visiting ? .sessions : saved }

    /// The switch, the palette or ⌘M: saved, and a visit ends.
    public func picking(_ content: NotchContent) -> NotchContentChoice { NotchContentChoice(saved: content) }

    /// ⌘M: the one that doesn't show.
    public func toggled() -> NotchContentChoice { picking(shown.other) }

    /// A session opened from the collapsed notch or the keyboard: the sessions show, whatever is saved.
    public func openingSession() -> NotchContentChoice { NotchContentChoice(saved: saved, visiting: true) }

    /// The notch closed: the saved choice shows the next time it opens.
    public func closing() -> NotchContentChoice { NotchContentChoice(saved: saved) }
}

/// What the wings beside the camera show in the collapsed notch.
public enum NotchWings: Equatable, Sendable {
    /// Nothing: the notch is exactly the camera housing.
    case hidden
    /// The status dot or Tonton, and the live session count (Settings › Notch › Activity dots).
    case dots
    /// A session, widened like the Dynamic Island (Settings › Notch › Live activity).
    case live(SessionSummary)
    /// The cover and an equalizer, while music plays in Music mode.
    case music

    /// `sessions` are the live sessions the notch shows. While music plays in Music mode the music takes the wings, whatever
    /// the activity dots setting says, and only a session that needs the user takes them back, as a call does over music on
    /// an iPhone. With nothing playing, the wings are those of Sessions mode.
    public static func pick(
        _ sessions: [SessionSummary], content: NotchContent, playing: Bool, dots: Bool, liveActivity: Bool
    ) -> NotchWings {
        let overMusic = content == .music && playing
        let candidates = overMusic ? sessions.filter(\.status.needsAttention) : sessions
        if liveActivity, let session = LiveActivity.pick(candidates) { return .live(session) }
        if overMusic { return .music }
        return dots && !sessions.isEmpty ? .dots : .hidden
    }

    /// The session of the live activity.
    public var session: SessionSummary? {
        switch self {
        case .live(let session): session
        default: nil
        }
    }
}
