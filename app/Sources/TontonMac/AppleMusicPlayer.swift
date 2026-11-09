import Foundation
import TontonCore

/// Apple Music in the notch, the same way as `SpotifyPlayer`. It sends nothing before `start()` and nothing while Music
/// doesn't run: a `tell` would launch it. It doesn't poll either: Music's `playerInfo` notification says when playback
/// changed, and a read follows each one for the position and the volume, which the notification lacks. Music has its own
/// Automation permission, asked apart from Spotify's, and gives the cover's bytes itself, read once per track.
@MainActor
public final class AppleMusicPlayer: MusicPlayer {
    public let app = AppleMusic.bundleId
    /// The app is called Music, which is also the name of Music mode: the notch says Apple Music, in every language.
    public let name = "Apple Music"
    public private(set) var state = MusicPlayerState() {
        didSet { if state != oldValue { onChange?(state) } }
    }
    public var onChange: ((MusicPlayerState) -> Void)?

    private let scripts: any ScriptRunning
    private let access: any AutomationAccess
    private let apps: any RunningApps
    private let notifications: any NotificationSource
    /// Music answers scripts a moment after it opens.
    private let launchDelay: TimeInterval
    private var started = false
    private var asking = false
    /// One read at a time: a change during one reads again once it is done.
    private var reading = false
    private var readAgain = false
    /// Bumped when Music quits: what was on its way before is dropped.
    private var generation = 0
    /// A drag of the volume sends many: the last one waits for the one on its way.
    private var pendingVolume: Int?
    private var sendingVolume = false
    /// The last notification, to drop the copy Music posts under iTunes' name.
    private var lastNotice: AppleMusic.Reading?
    private var lastNoticeDate: Date?

    public init(
        scripts: any ScriptRunning = AppleScriptRunner.shared, access: any AutomationAccess = SystemAutomationAccess(),
        apps: any RunningApps, notifications: any NotificationSource, launchDelay: TimeInterval = 2
    ) {
        self.scripts = scripts
        self.access = access
        self.apps = apps
        self.notifications = notifications
        self.launchDelay = launchDelay
    }

    public func start() {
        guard !started else { return }
        started = true
        apps.observe(app) { [weak self] running in self?.runningChanged(running) }
        for name in [AppleMusic.playerInfo, AppleMusic.iTunesPlayerInfo] {
            notifications.observe(name) { [weak self] userInfo in self?.received(userInfo) }
        }
        state.installed = apps.isInstalled(app)
        if apps.isRunning(app) {
            state.running = true
            refresh()
        }
    }

    public func refresh() {
        guard started, state.running else { return }
        // Asked again while denied: macOS answers without a prompt, and it may have been allowed in System Settings since.
        if state.access == .granted { read() } else { ask() }
    }

    public func perform(_ command: MusicCommand) {
        guard state.running, state.access == .granted else { return }
        state.nowPlaying = state.nowPlaying?.applying(command, at: Date())
        if case .volume(let volume) = command { return send(volume: volume) }
        let generation = self.generation
        Task {
            _ = await run(AppleMusic.script(for: command))
            // Its notification doesn't come for everything, a seek for one.
            if generation == self.generation { read() }
        }
    }

    /// From Music itself, for the track it plays now: nil once it has gone on to another, for a track without a cover, and
    /// for one too big to keep.
    public func artwork(for track: NowPlaying) async -> Data? {
        guard track.app == app, state.running, state.access == .granted, let script = track.trackId.flatMap(AppleMusic.artworkScript)
        else { return nil }
        let generation = self.generation
        guard let data = await attempt({ try await self.scripts.data(script) }), generation == self.generation, !data.isEmpty,
            data.count <= AppleMusic.maxArtworkBytes
        else { return nil }
        return data
    }

    public func activate() { apps.activate(app) }

    public func launch() { apps.launch(app) }

    private func runningChanged(_ running: Bool) {
        guard running != state.running else { return }
        state.running = running
        guard running else {
            generation += 1
            state.nowPlaying = nil
            lastNotice = nil
            return
        }
        state.installed = true
        let generation = self.generation
        Task {
            if launchDelay > 0 { try? await Task.sleep(nanoseconds: UInt64(launchDelay * 1_000_000_000)) }
            if generation == self.generation { refresh() }
        }
    }

    /// Shown at once, where the track had come to; the read that follows adds the position and the volume.
    private func received(_ userInfo: [AnyHashable: Any]) {
        guard started, state.running, state.access == .granted, let reading = AppleMusic.reading(fromNotification: userInfo) else {
            return
        }
        let date = Date()
        guard !AppleMusic.repeats(reading, at: date, last: lastNotice, receivedAt: lastNoticeDate) else { return }
        (lastNotice, lastNoticeDate) = (reading, date)
        state.nowPlaying = reading.nowPlaying(at: date, after: state.nowPlaying)
        read()
    }

    private func ask() {
        guard !asking else { return }
        asking = true
        let generation = self.generation
        Task {
            let access = await self.access.request(app)
            asking = false
            // Music quit meanwhile: macOS could not tell.
            guard generation == self.generation, state.running else { return }
            state.access = access
            if access == .granted { read() }
        }
    }

    private func read() {
        guard state.running, state.access == .granted else { return }
        if reading {
            readAgain = true
            return
        }
        reading = true
        let generation = self.generation
        Task {
            let output = await run(AppleMusic.readScript)
            reading = false
            if generation == self.generation, let output {
                state.nowPlaying = AppleMusic.reading(from: output)?.nowPlaying(at: Date(), after: state.nowPlaying)
            }
            if readAgain {
                readAgain = false
                refresh()
            }
        }
    }

    private func send(volume: Int) {
        pendingVolume = volume
        guard !sendingVolume else { return }
        sendingVolume = true
        Task {
            while let volume = pendingVolume {
                pendingVolume = nil
                _ = await run(AppleMusic.script(for: .volume(volume)))
            }
            sendingVolume = false
        }
    }

    /// The script's answer, nil when it failed.
    private func run(_ source: String) async -> String? {
        await attempt { try await self.scripts.run(source) }
    }

    /// Nil when the script failed. A refusal means the permission was turned off since; any other failure, as a track
    /// without a cover (-1728), leaves things as they are.
    private func attempt<Value>(_ script: () async throws -> Value) async -> Value? {
        do {
            return try await script()
        } catch let failure as ScriptFailure where failure.code == MusicAccess.notPermittedError {
            state.access = .denied
            return nil
        } catch {
            return nil
        }
    }
}
