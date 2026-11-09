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

    /// What the player shown plays. Nil when it plays nothing, or none is shown.
    @Published private(set) var nowPlaying: NowPlaying?
    /// The cover of the track, once the player gave it.
    @Published private(set) var cover: NSImage?
    /// The player the music view shows (`MusicChoice`): nil while none runs and none is pinned in Settings.
    @Published private(set) var shown: MusicChoice.Player?
    /// Every player, in the order of `players`: Settings lists them for the pin, and the view offers to open them.
    @Published private(set) var allPlayers: [MusicChoice.Player] = []
    /// The players may be asked what they play.
    private(set) var started = false
    /// The music view is on screen: the position ticks only then.
    private(set) var viewShown = false

    /// Every player Music mode follows. The order breaks ties in `MusicChoice`.
    private let players: [any MusicPlayer]
    private var choice = MusicChoice()
    private var pin: MusicPin
    /// Covers already had, by `NowPlaying.artworkKey`: the next time a track plays, its cover shows without asking again.
    private let covers = NSCache<NSString, NSImage>()
    private var coverKey: String?
    private var coverTask: Task<Void, Never>?
    private var subscriptions = Set<AnyCancellable>()
    private static let automationSettings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
    private static let accessibilitySettings = URL(
        string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")

    private init() {
        let apps = WorkspaceApps()
        let notifications = DistributedNotifications()
        players = [
            SpotifyPlayer(apps: apps, notifications: notifications),
            AppleMusicPlayer(apps: apps, notifications: notifications),
            NowPlayingPlayer(apps: apps),
        ]
        pin = AppSettings.shared.musicPlayer
        covers.countLimit = 50
        update()
        // The new value comes before the setting holds it.
        AppSettings.shared.$musicPlayer.dropFirst().removeDuplicates()
            .sink { [weak self] pin in
                self?.pin = pin
                self?.update()
            }
            .store(in: &subscriptions)
    }

    /// The first time Music mode opens, and at launch when it was opened before (`AppSettings.musicOpened`): the only
    /// place players may begin to get Apple Events. Running it again does nothing.
    func start() {
        guard !started else { return }
        started = true
        for player in players {
            player.onChange = { [weak self] _ in self?.update() }
            player.start()
        }
        update()
    }

    /// Reads the players again: the position, the volume and the permission may have changed while the view was closed. A
    /// player that doesn't run gets nothing.
    func viewAppeared() {
        viewShown = true
        if started { players.forEach { $0.refresh() } }
    }

    func viewDisappeared() { viewShown = false }

    func perform(_ action: MusicAction) {
        switch action {
        case .command(let command): chosen?.perform(command)
        case .showPlayer: chosen?.activate()
        case .openPlayer: chosen?.launch()
        case .launch(let app): players.first { $0.app == app }?.launch()
        case .openAutomationSettings: if let url = Self.automationSettings { NSWorkspace.shared.open(url) }
        case .openAccessibilitySettings: if let url = Self.accessibilitySettings { NSWorkspace.shared.open(url) }
        }
    }

    /// The player shown, which the controls drive.
    private var chosen: (any MusicPlayer)? {
        shown.flatMap { shown in players.first { $0.app == shown.app } }
    }

    private func update() {
        let all = players.map { MusicChoice.Player(app: $0.app, name: $0.name, state: $0.state) }
        choice = choice.noting(all)
        let shown = choice.pick(all, pinned: pin).flatMap { app in all.first { $0.app == app } }
        if allPlayers != all { allPlayers = all }
        if self.shown != shown { self.shown = shown }
        if nowPlaying != shown?.state.nowPlaying { nowPlaying = shown?.state.nowPlaying }
        showCover(of: shown?.state.nowPlaying)
    }

    private func showCover(of track: NowPlaying?) {
        let key = track?.artworkKey
        guard key != coverKey else { return }
        coverKey = key
        coverTask?.cancel()
        guard let track, let key, let player = chosen else {
            cover = nil
            return
        }
        if let cached = covers.object(forKey: key as NSString) {
            cover = cached
            return
        }
        // The last track's cover would show with the new title until this one arrives.
        cover = nil
        coverTask = Task { [weak self, player] in
            guard let data = await player.artwork(for: track), let image = NSImage(data: data) else { return }
            guard !Task.isCancelled, let self, self.coverKey == key else { return }
            self.covers.setObject(image, forKey: key as NSString)
            self.cover = image
        }
    }
}
