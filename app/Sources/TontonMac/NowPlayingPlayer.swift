import AppKit
import Foundation
import TontonCore

/// Every player that is neither Spotify nor Apple Music, as macOS's Now Playing sees it: Deezer, a web player in a browser,
/// VLC. Its `app` and `name` are those of the app playing. It reads through mediaremote-adapter, one `/usr/bin/perl` child
/// that runs from `start()` until the app quits and starts again, later each time, when it dies. The controls go through
/// the adapter too. What the child writes names what plays: it is never logged.
///
/// When the adapter can't read (its files are missing, it keeps dying, or Now Playing stays empty while an app plays
/// sound), it shows which app plays from Core Audio, and its controls post the media keys, once Accessibility allows it.
@MainActor
public final class NowPlayingPlayer: MusicPlayer {
    /// Its `app` until an app has played through Now Playing.
    public static let anyApp = "tech.d3l.tontonclaude.now-playing"

    public private(set) var app = NowPlayingPlayer.anyApp
    public private(set) var name = String(core: "Other players")
    public private(set) var state = MusicPlayerState(access: .granted) {
        didSet { if state != oldValue { onChange?(state) } }
    }
    public var onChange: ((MusicPlayerState) -> Void)?

    private let launcher: any ProcessLaunching
    private let files: AdapterFiles?
    private let apps: any RunningApps
    private let keys: any MediaKeyPosting
    private let audio: any AudioClientSource
    private let names: @MainActor (String) -> String?
    private let clock: @MainActor () -> Date
    private let sleep: @Sendable (TimeInterval) async -> Void
    /// Apps Core Audio's list leaves out: Spotify and Apple Music, which have their own way in, and Tonton.
    private let excluded: Set<String>

    private var started = false
    private var child: (any RunningProcess)?
    /// Bumped at each start and stop of the child: what an older one says is dropped.
    private var generation = 0
    private var startedAt = Date.distantPast
    private var restarts = AdapterRestarts()
    private var feed = NowPlayingFeed()
    private var readAt = Date.distantPast
    /// Decoded once each time the stream gives a new one.
    private var cover: Data?
    /// The adapter has said what plays since `start()`, for any app: it can read Now Playing on this Mac.
    private var proven = false
    /// The child on its way has.
    private var deliveredThisRun = false
    private var sounds: SoundingApps
    private var clients: [SoundingApps.Client] = []
    private var listening = false
    private var soundCheck: Task<Void, Never>?
    private var askedForKeys = false
    /// The app named, and whether it runs: once its track is gone, the notch can still open it.
    private var appRuns = false
    private var observed: Set<String> = []
    private var coverWaiters: [UUID: (track: NowPlaying, continuation: CheckedContinuation<Data?, Never>)] = [:]
    private var quitObserver: NSObjectProtocol?

    public init(
        apps: any RunningApps, launcher: (any ProcessLaunching)? = nil, files: AdapterFiles? = AdapterFiles.inBundle(),
        keys: (any MediaKeyPosting)? = nil, audio: (any AudioClientSource)? = nil,
        names: @escaping @MainActor (String) -> String? = NowPlayingPlayer.appName,
        tonton: String = Bundle.main.bundleIdentifier ?? "tech.d3l.tontonclaude", clock: @escaping @MainActor () -> Date = Date.init,
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64(max(0, $0) * 1e9)) }
    ) {
        self.apps = apps
        self.launcher = launcher ?? SystemProcesses()
        self.files = files
        self.keys = keys ?? SystemMediaKeys()
        self.audio = audio ?? CoreAudioClients()
        self.names = names
        self.clock = clock
        self.sleep = sleep
        excluded = MediaRemoteAdapter.ownPlayers.union([tonton])
        sounds = SoundingApps(excluding: excluded)
    }

    public func start() {
        guard !started else { return }
        started = true
        quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) {
            [weak self] _ in MainActor.assumeIsolated { self?.stop() }
        }
        startChild()
    }

    /// Ends the child and stops listening, as the app quits. A crash or a kill ends it too: its watcher sees Tonton go.
    public func stop() {
        guard started else { return }
        started = false
        generation += 1
        child?.stop()
        child = nil
        listen(false)
        if let quitObserver { NotificationCenter.default.removeObserver(quitObserver) }
        quitObserver = nil
        for (_, waiter) in coverWaiters { waiter.continuation.resume(returning: nil) }
        coverWaiters = [:]
    }

    /// Nothing to read again, the stream says each change. Accessibility may have been turned on since.
    public func refresh() {
        guard started else { return }
        update()
    }

    public func perform(_ command: MusicCommand) {
        guard started, let now = state.nowPlaying else { return }
        if failedOver {
            guard let key = MediaKey(command) else { return }
            guard keys.allowed else {
                askedForKeys = true
                keys.request()
                return update()
            }
            // An app is known to play: with none, the play key would open Apple Music.
            return keys.post(key)
        }
        guard let files, let arguments = files.arguments(for: command) else { return }
        state.nowPlaying = now.applying(command, at: clock())
        let launcher = self.launcher
        Task { _ = await launcher.run(AdapterFiles.perl, arguments) }
    }

    /// The bytes the stream gave, which can come a moment after the track: it waits for them while the track plays.
    public func artwork(for track: NowPlaying) async -> Data? {
        if let ready = cover(for: track) { return ready }
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in coverWaiters[id] = (track, continuation) }
        } onCancel: {
            Task { @MainActor [weak self] in self?.coverWaiters.removeValue(forKey: id)?.continuation.resume(returning: nil) }
        }
    }

    public func activate() { if app != Self.anyApp { apps.activate(app) } }

    public func launch() { if app != Self.anyApp { apps.launch(app) } }

    /// The app's name as Finder and the Dock write it.
    public static func appName(_ bundleId: String) -> String? {
        if let name = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first?.localizedName { return name }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return nil }
        let name = FileManager.default.displayName(atPath: url.path)
        return name.hasSuffix(".app") ? String(name.dropLast(4)) : name
    }

    // MARK: - The child

    private func startChild() {
        guard started, child == nil else { return }
        generation += 1
        let generation = self.generation
        feed = NowPlayingFeed()
        cover = nil
        deliveredThisRun = false
        if let files {
            do {
                child = try launcher.stream(
                    AdapterFiles.perl, files.streamArguments, line: { [weak self] line in self?.received(line, generation) },
                    exit: { [weak self] _ in self?.exited(generation) })
                startedAt = clock()
            } catch {
                restart(after: restarts.stopped(afterRunning: 0), generation)
            }
        }
        update()
    }

    private func received(_ line: Data, _ generation: Int) {
        guard generation == self.generation, let changed = feed.apply(line) else { return }
        readAt = clock()
        if !feed.isEmpty {
            proven = true
            deliveredThisRun = true
        }
        if changed.contains("artworkData") { cover = feed.artwork }
        update()
    }

    private func exited(_ generation: Int) {
        guard generation == self.generation else { return }
        child = nil
        feed = NowPlayingFeed()
        cover = nil
        restart(after: restarts.stopped(afterRunning: clock().timeIntervalSince(startedAt)), generation)
        update()
    }

    private func restart(after delay: TimeInterval, _ generation: Int) {
        let sleep = self.sleep
        Task { [weak self] in
            await sleep(delay)
            guard let self, self.generation == generation else { return }
            self.startChild()
        }
    }

    // MARK: - What shows

    /// The adapter can't read: its files are missing, it keeps dying, or Now Playing stays empty while an app plays.
    private var failedOver: Bool {
        files == nil || (restarts.failing && !deliveredThisRun) || (!proven && sounds.playedLong(at: clock()))
    }

    private func update() {
        // Core Audio is listened to while it may be needed: until the adapter has read something, and while it can't.
        listen(started && (!proven || failedOver))
        let now: NowPlaying?
        var mediaKeys: MusicAccess?
        if failedOver {
            now = sounds.shown.map {
                NowPlaying(app: $0.app, title: "", artist: "", album: "", isPlaying: $0.sounding, positionDate: .distantPast)
            }
            mediaKeys = keys.allowed ? .granted : askedForKeys ? .denied : .unknown
        } else {
            now = feed.nowPlaying(at: readAt)
        }
        if let shown = now?.app, shown != app { show(shown) }
        state = MusicPlayerState(installed: true, running: now != nil || appRuns, access: .granted, nowPlaying: now, mediaKeys: mediaKeys)
        handOverCovers()
    }

    private func show(_ app: String) {
        self.app = app
        name = names(app) ?? String(core: "Other players")
        appRuns = apps.isRunning(app)
        guard observed.insert(app).inserted else { return }
        apps.observe(app) { [weak self] running in
            guard let self, self.app == app else { return }
            self.appRuns = running
            self.update()
        }
    }

    // MARK: - The fallback

    private func listen(_ on: Bool) {
        guard on != listening else { return }
        listening = on
        if on {
            // It answers at once with the clients of now.
            _ = audio.start { [weak self] clients in self?.heard(clients) }
        } else {
            audio.stop()
            soundCheck?.cancel()
            soundCheck = nil
            clients = []
            sounds = SoundingApps(excluding: excluded)
        }
    }

    private func heard(_ clients: [SoundingApps.Client]) {
        guard listening else { return }
        self.clients = clients
        let next = sounds.update(clients, at: clock())
        soundCheck?.cancel()
        soundCheck = next.map { next in
            let sleep = self.sleep
            let delay = max(0, next.timeIntervalSince(clock()))
            return Task { [weak self] in
                await sleep(delay)
                guard !Task.isCancelled, let self else { return }
                self.heard(self.clients)
            }
        }
        update()
    }

    // MARK: - Covers

    /// Nil while the cover of `track` may still come.
    private func cover(for track: NowPlaying) -> Data?? {
        guard !failedOver, let now = state.nowPlaying, now.app == track.app, now.isSameTrack(as: track) else { return .some(nil) }
        if let cover { return .some(cover) }
        return nil
    }

    private func handOverCovers() {
        for (id, waiter) in coverWaiters {
            guard let ready = cover(for: waiter.track) else { continue }
            coverWaiters[id] = nil
            waiter.continuation.resume(returning: ready)
        }
    }
}
