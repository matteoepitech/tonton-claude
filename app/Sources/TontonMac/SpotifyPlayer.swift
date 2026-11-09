import Foundation
import TontonCore

/// Spotify in the notch. It sends nothing before `start()` and nothing while Spotify doesn't run: a `tell` would launch
/// it. It doesn't poll either: Spotify's notification says when playback changed, and a read follows each one for the
/// volume and the cover, which the notification lacks.
@MainActor
public final class SpotifyPlayer: MusicPlayer {
    public let app = Spotify.bundleId
    public let name = "Spotify"
    public private(set) var state = MusicPlayerState() {
        didSet { if state != oldValue { onChange?(state) } }
    }
    public var onChange: ((MusicPlayerState) -> Void)?

    private let scripts: any ScriptRunning
    private let access: any AutomationAccess
    private let apps: any RunningApps
    private let notifications: any NotificationSource
    private let download: @Sendable (URL) async -> Data?
    /// Spotify answers scripts a moment after it opens.
    private let launchDelay: TimeInterval
    private var started = false
    private var asking = false
    /// One read at a time: a change during one reads again once it is done.
    private var reading = false
    private var readAgain = false
    /// Bumped when Spotify quits: what was on its way before is dropped.
    private var generation = 0
    /// A drag of the volume sends many: the last one waits for the one on its way.
    private var pendingVolume: Int?
    private var sendingVolume = false

    public init(
        scripts: any ScriptRunning = AppleScriptRunner.shared, access: any AutomationAccess = SystemAutomationAccess(),
        apps: any RunningApps, notifications: any NotificationSource,
        download: @escaping @Sendable (URL) async -> Data? = SpotifyCovers.download, launchDelay: TimeInterval = 2
    ) {
        self.scripts = scripts
        self.access = access
        self.apps = apps
        self.notifications = notifications
        self.download = download
        self.launchDelay = launchDelay
    }

    public func start() {
        guard !started else { return }
        started = true
        apps.observe(app) { [weak self] running in self?.runningChanged(running) }
        notifications.observe(Spotify.playbackChanged) { [weak self] userInfo in self?.received(userInfo) }
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
            _ = await run(Spotify.script(for: command))
            // Its notification doesn't come for everything, a seek for one.
            if generation == self.generation { read() }
        }
    }

    /// From Spotify's own image server only: the address comes from Spotify, and nothing else is fetched.
    public func artwork(for track: NowPlaying) async -> Data? {
        guard track.app == app, let url = track.artworkURL.flatMap({ Spotify.artworkURL($0.absoluteString) }) else { return nil }
        return await download(url)
    }

    public func activate() { apps.activate(app) }

    public func launch() { apps.launch(app) }

    private func runningChanged(_ running: Bool) {
        guard running != state.running else { return }
        state.running = running
        guard running else {
            generation += 1
            state.nowPlaying = nil
            return
        }
        state.installed = true
        let generation = self.generation
        Task {
            if launchDelay > 0 { try? await Task.sleep(nanoseconds: UInt64(launchDelay * 1_000_000_000)) }
            if generation == self.generation { refresh() }
        }
    }

    /// Shown at once; the read that follows adds the volume and the cover.
    private func received(_ userInfo: [AnyHashable: Any]) {
        guard started, state.running, state.access == .granted, let reading = Spotify.reading(fromNotification: userInfo) else { return }
        state.nowPlaying = reading.nowPlaying(at: Date())?.keeping(from: state.nowPlaying)
        read()
    }

    private func ask() {
        guard !asking else { return }
        asking = true
        let generation = self.generation
        Task {
            let access = await self.access.request(app)
            asking = false
            // Spotify quit meanwhile: macOS could not tell.
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
            let output = await run(Spotify.readScript)
            reading = false
            if generation == self.generation, let output {
                state.nowPlaying = Spotify.reading(from: output)?.nowPlaying(at: Date())?.keeping(from: state.nowPlaying)
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
                _ = await run(Spotify.script(for: .volume(volume)))
            }
            sendingVolume = false
        }
    }

    /// The script's answer, nil when it failed. A refusal means the permission was turned off since.
    private func run(_ source: String) async -> String? {
        do {
            return try await scripts.run(source)
        } catch let failure as ScriptFailure where failure.code == MusicAccess.notPermittedError {
            state.access = .denied
            return nil
        } catch {
            return nil
        }
    }
}

/// Spotify's covers, from its image server: a request with no cookies and no cache on disk, which says nothing but the
/// image's address. Nothing goes to the relay.
public enum SpotifyCovers {
    /// A 640-pixel JPEG weighs about 100 KB: anything much bigger is no cover.
    static let maxBytes = 4 * 1024 * 1024
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        return URLSession(configuration: configuration)
    }()

    @Sendable public static func download(_ url: URL) async -> Data? {
        guard let (data, response) = try? await session.data(from: url), (response as? HTTPURLResponse)?.statusCode == 200,
            data.count <= maxBytes
        else { return nil }
        return data
    }
}
