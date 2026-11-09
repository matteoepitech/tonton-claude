import AppKit
import Combine
import TontonCore
import TontonMac

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
    /// The player as the music view shows it: running or not, allowed or not, and what it plays.
    @Published private(set) var player = MusicPlayerState()
    /// The players may be asked what they play.
    private(set) var started = false
    /// The music view is on screen: the position ticks only then.
    private(set) var viewShown = false

    /// Spotify for now; Apple Music and the system's Now Playing come next.
    private let source: any MusicPlayer
    /// Covers already had, by `NowPlaying.artworkKey`: the next time a track plays, its cover shows without asking again.
    private let covers = NSCache<NSString, NSImage>()
    private var coverKey: String?
    private var coverTask: Task<Void, Never>?
    private static let automationSettings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")

    var playerName: String { source.name }

    private init() {
        source = SpotifyPlayer(apps: WorkspaceApps(), notifications: DistributedNotifications())
        covers.countLimit = 50
        player = source.state
    }

    /// The first time Music mode opens, and at launch when it was opened before (`AppSettings.musicOpened`): the only
    /// place players may begin to get Apple Events. Running it again does nothing.
    func start() {
        guard !started else { return }
        started = true
        source.onChange = { [weak self] state in self?.update(state) }
        source.start()
        update(source.state)
    }

    /// Reads the player again: the position, the volume and the permission may have changed while the view was closed.
    func viewAppeared() {
        viewShown = true
        if started { source.refresh() }
    }

    func viewDisappeared() { viewShown = false }

    func perform(_ action: MusicAction) {
        switch action {
        case .command(let command): source.perform(command)
        case .showPlayer: source.activate()
        case .openPlayer: source.launch()
        case .openAutomationSettings: if let url = Self.automationSettings { NSWorkspace.shared.open(url) }
        }
    }

    private func update(_ state: MusicPlayerState) {
        if player != state { player = state }
        if nowPlaying != state.nowPlaying { nowPlaying = state.nowPlaying }
        showCover(of: state.nowPlaying)
    }

    private func showCover(of track: NowPlaying?) {
        let key = track?.artworkKey
        guard key != coverKey else { return }
        coverKey = key
        coverTask?.cancel()
        guard let track, let key else {
            cover = nil
            return
        }
        if let cached = covers.object(forKey: key as NSString) {
            cover = cached
            return
        }
        // The last track's cover would show with the new title until this one arrives.
        cover = nil
        coverTask = Task { [weak self, source] in
            guard let data = await source.artwork(for: track), let image = NSImage(data: data) else { return }
            guard !Task.isCancelled, let self, self.coverKey == key else { return }
            self.covers.setObject(image, forKey: key as NSString)
            self.cover = image
        }
    }
}
