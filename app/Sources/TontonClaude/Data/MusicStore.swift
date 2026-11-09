import AppKit
import Combine
import TontonCore

/// The music playing on this Mac, for the notch's Music mode and its wings. Nothing of it leaves the Mac or goes to the
/// logs. Players are only asked once `start()` ran: asking sends them Apple Events, which can show an Automation prompt,
/// so not before the user opened Music mode.
@MainActor
final class MusicStore: ObservableObject {
    static let shared = MusicStore()

    /// Nil when no player plays or holds a track.
    @Published private(set) var nowPlaying: NowPlaying?
    /// The cover of the track, once a player gave it.
    @Published private(set) var cover: NSImage?
    /// The players may be asked what they play.
    private(set) var started = false
    /// The music view is on screen: the position ticks only then.
    private(set) var viewShown = false

    private init() {}

    /// The first time Music mode opens, and at launch when it was opened before (`AppSettings.musicOpened`): the only
    /// place players may begin to get Apple Events. Running it again does nothing.
    func start() {
        guard !started else { return }
        started = true
    }

    func viewAppeared() { viewShown = true }

    func viewDisappeared() { viewShown = false }
}
