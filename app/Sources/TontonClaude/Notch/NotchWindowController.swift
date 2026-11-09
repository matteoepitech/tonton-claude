import AppKit
import Carbon.HIToolbox
import Combine
import SwiftUI
import TontonCore

/// Borderless panel above the menu bar that can take keyboard focus without activating the app.
final class NotchPanel: NSPanel {
    /// In use: above the menu bar, so the open notch hangs from the camera.
    static let raisedLevel = NSWindow.Level.statusBar + 1
    /// While another app has the keyboard (a launcher, Spotlight, an alert, a pinned notch left open): behind it.
    static let loweredLevel = NSWindow.Level.normal

    init(size: CGSize) {
        super.init(
            contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = Self.raisedLevel
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isMovable = false
        ignoresMouseEvents = true
        acceptsMouseMovedEvents = true
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Owns the notch: a fixed-size transparent panel at the top of the screen in which the visible shape animates.
/// The panel ignores the mouse unless the notch is open, so the menu bar stays usable.
@MainActor
final class NotchWindowController {
    let state = NotchState()

    private let store: SessionStore
    private let settings: AppSettings
    private let panel: NotchPanel
    private var monitors: [Any] = []
    private var subscriptions = Set<AnyCancellable>()
    /// The session whose turn ended last: the XP that follows floats from its row.
    private var lastTurn: (id: String, at: Date)?
    private var collapseTask: Task<Void, Never>?
    private var overlapTask: Task<Void, Never>?
    private var behindFloatingWindow = false
    private var peekTask: Task<Void, Never>?
    private var openedByHover = false
    /// Waits a moment before the preview of a pill shows, so a pointer passing over the pills shows nothing.
    private var previewTask: Task<Void, Never>?
    /// The last other app in front, given back the focus when the notch closes.
    private var previousApp: NSRunningApplication?
    /// ⌃ pressed alone: dictation starts unless another key comes first.
    private var pushToTalkTask: Task<Void, Never>?
    /// Sessions that finished since the open notch last showed the sessions: in Music mode they keep their pill.
    private let finishedUnseen = CurrentValueSubject<Set<String>, Never>([])

    init(store: SessionStore, settings: AppSettings) {
        self.store = store
        self.settings = settings
        panel = NotchPanel(size: NotchState.expandedSize)
        let root = NotchRootView(onSettings: { AppDelegate.shared?.showSettings() })
            .environmentObject(state)
            .environmentObject(store)
            .environmentObject(settings)
        panel.contentView = NSHostingView(rootView: root)
        panel.orderFrontRegardless()

        previousApp = NSWorkspace.shared.frontmostApplication.flatMap { $0 == .current ? nil : $0 }
        layout()
        installEventMonitors()
        observe()
    }

    // MARK: Layout

    /// The built-in display (the one with a notch) or the main screen, as chosen in the settings.
    private var screen: NSScreen? {
        switch settings.display {
        case .builtIn: NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main
        case .main: NSScreen.main
        }
    }

    func layout() {
        guard let screen else { return }
        let frame = screen.frame
        if screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            state.notchSize = CGSize(width: frame.width - left.width - right.width, height: screen.safeAreaInsets.top)
            state.hasPhysicalNotch = true
        } else {
            state.notchSize = CGSize(width: 190, height: max(24, frame.maxY - screen.visibleFrame.maxY))
            state.hasPhysicalNotch = false
        }
        let size = NotchState.expandedSize
        panel.setFrame(
            NSRect(x: frame.midX - size.width / 2, y: frame.maxY - size.height, width: size.width, height: size.height), display: true)
        panel.contentView?.frame = NSRect(origin: .zero, size: size)
    }

    /// Frame of the session pills under the collapsed notch, in screen coordinates.
    private var pillsFrame: NSRect {
        let width = state.pills.width
        let top = panel.frame.maxY - state.collapsedSize.height - NotchState.pillGap
        return NSRect(x: panel.frame.midX - width / 2, y: top - NotchState.pillHeight, width: width, height: NotchState.pillHeight)
    }

    private var pointerOnPills: Bool { state.mode == .collapsed && state.pills.pillCount > 0 && pillsFrame.contains(NSEvent.mouseLocation) }

    /// The pill under the pointer: a session's, or `sessions.count` for the `+N` one. Nil between pills.
    private var pillUnderPointer: Int? {
        pointerOnPills ? state.pills.pill(at: NSEvent.mouseLocation.x - pillsFrame.minX) : nil
    }

    /// Frame of the preview card while it shows, in screen coordinates, with the gap above it: the pointer crosses it on
    /// the way from the pill to the card.
    private var previewFrame: NSRect? {
        guard state.mode == .collapsed, let index = state.previewPill else { return nil }
        let x = panel.frame.minX + state.pills.previewX(for: index, within: panel.frame.width)
        let height = PillRow.previewHeight + PillRow.previewGap
        return NSRect(x: x, y: pillsFrame.minY - height, width: PillRow.previewWidth, height: height)
    }

    private var pointerOnPreview: Bool { previewFrame?.contains(NSEvent.mouseLocation) == true }

    /// Over the banner of a session: a click opens it.
    private var pointerOnPeek: Bool {
        state.mode == .peek && state.peekSession != nil && shapeFrame(state.peekSize).contains(NSEvent.mouseLocation)
    }

    /// Frame of the visible shape, in screen coordinates.
    private func shapeFrame(_ size: CGSize) -> NSRect {
        NSRect(x: panel.frame.midX - size.width / 2, y: panel.frame.maxY - size.height, width: size.width, height: size.height)
    }

    // MARK: Opening and closing

    func expand(byHover: Bool = false) {
        peekTask?.cancel()
        collapseTask?.cancel()
        hidePreview()
        if state.mode != .expanded {
            openedByHover = byHover
            // A visit to the sessions from Music mode ended when the notch closed. It is dropped as the notch opens again
            // rather than as it closes, so the music doesn't show through the closing animation.
            state.content = state.content.closing()
        }
        panel.level = NotchPanel.raisedLevel
        withAnimation(.spring(response: 0.38, dampingFraction: 0.82)) { state.mode = .expanded }
        takeFocus()
        watchFloatingWindows()
    }

    /// Opens the notch on a session, in Music mode too; nil opens the sessions as they were.
    private func open(session id: String?, byHover: Bool = false) {
        expand(byHover: byHover)
        if let id {
            store.selectedId = id
            state.showHero = false
        }
        state.visitSessions()
    }

    /// `force` also closes a pinned notch (escape, opening the settings) and unpins it.
    func collapse(force: Bool = false) {
        collapseTask?.cancel()
        if force { state.pinned = false }
        state.showPalette = false
        state.showNewSession = false
        state.menu = nil
        guard !state.pinned, state.mode != .collapsed else { return }
        withAnimation(.spring(response: 0.35, dampingFraction: 0.9)) { state.mode = .collapsed }
        overlapTask?.cancel()
        behindFloatingWindow = false
        panel.makeFirstResponder(nil)
        panel.resignKey()
        panel.level = NotchPanel.raisedLevel
        giveFocusBack()
    }

    /// Makes Tonton Claude the active app: macOS only shows the text cursor in the active app, and tools acting on the frontmost
    /// app (a launcher's paste action, dictation) then target the chat.
    private func takeFocus() {
        // The cooperative `NSApp.activate()` is refused to an accessory app that is not in front; this one is honoured.
        if !NSApp.isActive { NSApp.activate(ignoringOtherApps: true) }
        panel.makeKey()
    }

    /// Skipped when another window of the app is on screen (settings, file panel): it keeps the focus.
    private func giveFocusBack() {
        guard NSApp.isActive, let previousApp, !previousApp.isTerminated else { return }
        guard !NSApp.windows.contains(where: { $0 !== panel && $0.isVisible && $0.canBecomeKey }) else { return }
        NSApp.yieldActivation(to: previousApp)
        previousApp.activate()
    }

    /// Another app took over: close the notch, or step behind its windows if pinned.
    private func otherAppActivated(_ app: NSRunningApplication) {
        previousApp = app
        guard state.mode == .expanded else { return }
        if state.pinned { panel.level = NotchPanel.loweredLevel } else { collapse() }
    }

    /// Panels of other apps (launchers, Spotlight, alerts) open without any notification to this app, even when they take the
    /// keyboard: while the notch is open, check for one over it and step behind it until it closes.
    private func watchFloatingWindows() {
        overlapTask?.cancel()
        overlapTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.updateLevelForFloatingWindows()
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    private func updateLevelForFloatingWindows() {
        let covered = FloatingWindows.overlap(shapeFrame(NotchState.expandedSize))
        guard covered != behindFloatingWindow else { return }
        behindFloatingWindow = covered
        let steppedAside = state.pinned && !NSApp.isActive
        panel.level = covered || steppedAside ? NotchPanel.loweredLevel : NotchPanel.raisedLevel
    }

    private var isRaised: Bool { panel.level == NotchPanel.raisedLevel }

    func toggle() {
        state.mode == .expanded ? collapse(force: true) : expand()
    }

    /// Leaving the notch with the pointer must not close it while a message is being written.
    private var isTyping: Bool { panel.isKeyWindow && panel.firstResponder is NSTextView }

    // MARK: Alerts

    /// A session needs the user or just finished: sound, haptics, notification, then the banner or the open notch.
    private func alert(_ session: SessionSummary, finished: Bool) {
        guard !settings.isQuiet(.of(session.status, finished: finished)) else { return }
        signal(.of(session.status, finished: finished), project: session.project)
        if settings.systemNotifications {
            Notifier.post(session, body: finished ? String(localized: "Claude is done.") : session.displayStatusText)
        }
        if settings.openOnPermission && session.status == .permission {
            open(session: session.id)
        } else {
            peek(session)
        }
    }

    /// VoiceOver reads it out at once, wherever its cursor is; without VoiceOver nothing happens.
    private func announce(_ text: String) {
        NSAccessibility.post(
            element: panel, notification: .announcementRequested,
            userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }

    /// Sessions a usage limit stopped can go again: the same sound and banner, once for all of them.
    private func limitLifted(_ sessions: [SessionSummary]) {
        guard let session = sessions.first, !settings.isQuiet(.limitReset) else { return }
        signal(.finished)
        if settings.systemNotifications {
            let body =
                sessions.count > 1
                ? String(localized: "The usage limit reset. \(sessions.count) sessions can go again.")
                : String(localized: "The usage limit reset. Claude can go again.")
            Notifier.post(session, body: body)
        }
        peek(session, text: String(localized: "Usage limit reset"))
    }

    /// Confetti from the notch for a long task done. None with Reduce Motion, during quiet hours or a Focus that silences
    /// finished tasks.
    private func celebrate() {
        guard !settings.isQuiet(.finished), !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        let seed = UInt64.random(in: 1...UInt64.max)
        state.confetti = seed
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Confetti.duration + 0.2))
            if self?.state.confetti == seed { self?.state.confetti = nil }
        }
    }

    /// XP floats from the session's row into Tonton's ring, and a new level shows for a moment across the notch. Like the
    /// bottom bar's "+XP" before them: not during quiet hours, not without the mascot, and a level-up waits for no session
    /// to need the user. Reduce Motion keeps the float away and the moment still.
    private func earned(_ xp: Int, level: Int?) {
        guard settings.showMascot, settings.showAlerts, !settings.isQuiet(.other) else { return }
        if state.mode == .expanded, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let float = XPFloat(xp: xp, session: lastTurn.flatMap { Date().timeIntervalSince($0.at) < 60 ? $0.id : nil })
            state.xpFloat = float
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(XPFloatView.duration + 0.2))
                if self?.state.xpFloat == float { self?.state.xpFloat = nil }
            }
        }
        guard let level, store.attentionCount == 0 else { return }
        state.levelUp = level
        announce(String(localized: "Tonton reached level \(level)"))
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(LevelUpMoment.duration))
            if self?.state.levelUp == level { self?.state.levelUp = nil }
        }
    }

    private func signal(_ event: SoundEvent, project: String? = nil) {
        let sound = project.map { settings.sound(for: event, project: $0) } ?? settings.sound(for: event)
        if settings.soundOnAttention { SoundPlayer.play(sound) }
        if settings.haptics { NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .now) }
    }

    /// Today's spending went past the daily budget of Settings › General.
    private func budgetExceeded(_ period: BudgetPeriod, _ spent: Double) {
        guard !settings.isQuiet(.other) else { return }
        signal(.question)
        let budget = Money.dollars(Double(period == .day ? settings.dailyBudget : settings.monthlyBudget), digits: 0)
        let text =
            switch period {
            case .day: String(localized: "Today's cost passed \(budget): \(Money.dollars(spent)) so far")
            case .month: String(localized: "This month's cost passed \(budget): \(Money.dollars(spent)) so far")
            }
        let title = period == .day ? String(localized: "Daily budget") : String(localized: "Monthly budget")
        if settings.systemNotifications { Notifier.post(title: title, body: text) }
        peek(nil, text: text)
    }

    /// `text` replaces the session's status in the banner, or stands alone without a session.
    private func peek(_ session: SessionSummary?, text: String? = nil) {
        guard settings.showAlerts, state.mode != .expanded else { return }
        state.peekSession = session
        state.peekText = text
        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { state.mode = .peek }
        peekTask?.cancel()
        peekTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard let self, !Task.isCancelled, self.state.mode == .peek else { return }
            withAnimation(.spring(response: 0.35, dampingFraction: 0.9)) { self.state.mode = .collapsed }
        }
    }

    // MARK: Events

    private func observe() {
        NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
            .sink { [weak self] _ in self?.layout() }
            .store(in: &subscriptions)
        settings.$notchSize.combineLatest(settings.$display)
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.layout() }
            .store(in: &subscriptions)
        state.$mode
            .sink { [weak self] mode in self?.panel.ignoresMouseEvents = mode != .expanded }
            .store(in: &subscriptions)
        NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didActivateApplicationNotification)
            .compactMap { $0.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication }
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
            .sink { [weak self] app in self?.otherAppActivated(app) }
            .store(in: &subscriptions)
        // What the collapsed notch is about: a visit to the sessions ends with the open notch.
        let content = state.$content.map(\.saved).removeDuplicates()
        store.sessionsPublisher.combineLatest(settings.$showPills, settings.$hiddenMachines, settings.$pinnedSessions)
            .combineLatest(settings.$projectTags, content, finishedUnseen)
            .map { [store] values, tags, content, unseen in
                let (sessions, on, hidden, pinned) = values
                let shown = sessions.filter { !hidden.contains($0.machine) }
                let ordered = SessionLayout.ordered(shown, pinned: pinned, thisMac: store.thisMachines, tags: tags)
                return on ? PillRow(content.pills(ordered, finishedUnseen: unseen)) : PillRow([])
            }
            .removeDuplicates()
            .sink { [weak self] row in self?.state.pills = row }
            .store(in: &subscriptions)
        store.attention
            .sink { [weak self] session in self?.alert(session, finished: false) }
            .store(in: &subscriptions)
        store.permissionsAsked
            .filter { [settings] _ in !settings.isQuiet(.permission) }
            .sink { [weak self] asked in self?.announce(Spoken.permissions(asked.requests, session: asked.session.project)) }
            .store(in: &subscriptions)
        // The user started the session: its questions open the notch whatever the settings say.
        store.launchAsks
            .sink { [weak self] _ in
                if self?.settings.isQuiet(.needsYou) == false { self?.signal(.question) }
                self?.state.showNewSession = true
                self?.expand()
            }
            .store(in: &subscriptions)
        store.launchStarted
            .sink { [weak self] _ in if self?.store.launches.isEmpty == true { self?.state.showNewSession = false } }
            .store(in: &subscriptions)
        store.taskDone
            .sink { [weak self] session, _ in self?.lastTurn = (session.id, Date()) }
            .store(in: &subscriptions)
        store.finished
            .filter { [state] _ in !Self.showsSessions(state.mode, state.content) }
            .sink { [finishedUnseen] session in finishedUnseen.send(finishedUnseen.value.union([session.id])) }
            .store(in: &subscriptions)
        let notch = state.$mode.combineLatest(state.$content)
        notch.filter { Self.showsSessions($0, $1) }
            .sink { [finishedUnseen] _ in if !finishedUnseen.value.isEmpty { finishedUnseen.send([]) } }
            .store(in: &subscriptions)
        content.dropFirst().sink { [settings] in settings.notchContent = $0 }.store(in: &subscriptions)
        // Players get no Apple Events before the user opened Music mode once: from then on, they do from launch.
        notch.map { [settings] mode, content in
            NotchContent.listensToPlayers(musicOpened: settings.musicOpened, showing: mode == .expanded ? content.shown : nil)
        }
        .first { $0 }
        .sink { [settings] _ in
            if !settings.musicOpened { settings.musicOpened = true }
            MusicStore.shared.start()
        }
        .store(in: &subscriptions)
        RPGStore.shared.earned
            .sink { [weak self] earned in self?.earned(earned.xp, level: earned.level) }
            .store(in: &subscriptions)
        store.taskDone
            .filter { [settings] _, worked in settings.confettiAfterMinutes > 0 && worked >= Double(settings.confettiAfterMinutes) * 60 }
            .filter { [store] session, _ in !store.snoozes.isSnoozed(session.id) }
            .sink { [weak self] _ in self?.celebrate() }
            .store(in: &subscriptions)
        store.finished
            .filter { [settings] _ in settings.alertOnFinish }
            .sink { [weak self] session in self?.alert(session, finished: true) }
            .store(in: &subscriptions)
        store.usage.budgetExceeded
            .sink { [weak self] alert in self?.budgetExceeded(alert.period, alert.spent) }
            .store(in: &subscriptions)
        store.limitLifted
            .filter { [settings] _ in settings.alertOnLimitReset }
            // Auto-continue still runs for a snoozed session (SessionStore); only the alert is muted.
            .map { [store] sessions in sessions.filter { store.snoozes.allows(.limitReset, for: $0.id) } }
            .sink { [weak self] sessions in self?.limitLifted(sessions) }
            .store(in: &subscriptions)
        let shown = store.sessionsPublisher.combineLatest(settings.$hiddenMachines)
            .map { sessions, hidden in sessions.filter { $0.status.isLive && !hidden.contains($0.machine) } }
        let playing = MusicStore.shared.$nowPlaying.map { $0?.isPlaying == true }.removeDuplicates()
        let dots = settings.$showActivityDots.combineLatest(settings.$showMascot).map { $0 || $1 }
        let wings = shown.combineLatest(dots, settings.$liveActivity, content.combineLatest(playing))
            .map { sessions, dots, live, music in
                NotchWings.pick(sessions, content: music.0, playing: music.1, dots: dots, liveActivity: live)
            }
        let activity = wings.map(\.session)
        // A new session or a new state animates the wings; a new title within the same state just shows.
        activity
            .removeDuplicates { $0?.id == $1?.id && $0?.status == $1?.status }
            .sink { [weak self] session in
                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { self?.state.liveActivity = session }
            }
            .store(in: &subscriptions)
        activity
            .sink { [weak self] session in if let self, session?.id == self.state.liveActivity?.id { self.state.liveActivity = session } }
            .store(in: &subscriptions)
        wings.map { $0 == .music }
            .removeDuplicates()
            .sink { [weak self] music in withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { self?.state.musicWings = music } }
            .store(in: &subscriptions)
        wings.map { $0 != .hidden }
            .removeDuplicates()
            .sink { [weak self] show in withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { self?.state.showWings = show } }
            .store(in: &subscriptions)
        // Limits reset with time alone, so check again every minute.
        let minutes = Timer.publish(every: 60, on: .main, in: .common).autoconnect().prepend(Date())
        store.sessionsPublisher.combineLatest(settings.$hiddenMachines, minutes)
            .map { sessions, hidden, now in
                let live = sessions.filter { $0.status.isLive && !hidden.contains($0.machine) }
                return UsageLimit.soonest(live.map { $0.limitToWatch(at: now) }, at: now) != nil
            }
            .removeDuplicates()
            .sink { [weak self] wide in withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { self?.state.wingCountdown = wide } }
            .store(in: &subscriptions)
    }

    /// The open notch shows the sessions: the user sees which ones finished.
    private static func showsSessions(_ mode: NotchState.Mode, _ content: NotchContentChoice) -> Bool {
        mode == .expanded && content.shown == .sessions
    }

    private func installEventMonitors() {
        let pointerMoved: (NSEvent) -> Void = { [weak self] _ in Task { @MainActor in self?.pointerMoved() } }
        addMonitor(NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: pointerMoved))
        addMonitor(
            NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { event in
                pointerMoved(event)
                return event
            })
        // Global monitors see clicks in other apps: a click anywhere else closes the open notch.
        addMonitor(
            NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                Task { @MainActor in self?.clickedOutside() }
            })
        addMonitor(
            NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                guard let self, event.window === self.panel else { return event }
                if self.state.mode == .expanded { self.openedByHover = false }
                if self.pointerOnPreview, let index = self.state.previewPill { return self.openPill(index) }
                if self.pointerOnPills { return self.clickedPill() ? nil : event }
                if self.pointerOnPeek, let session = self.state.peekSession {
                    self.open(session: session.id)
                    return nil
                }
                return event
            })
        addMonitor(
            NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
                if let self, event.window === self.panel { self.modifiersChanged(event) }
                return event
            })
        addMonitor(
            NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.state.mode == .expanded, event.window === self.panel else { return event }
                // ⌃ was part of a shortcut (⌃A, ⌃E…), not a press to talk.
                self.pushToTalkTask?.cancel()
                if self.handleKey(event) { return nil }
                self.openedByHover = false
                return event
            })
    }

    /// Holding ⌃ alone dictates into the composer, after a moment so ⌃ shortcuts keep working; releasing it stops.
    private func modifiersChanged(_ event: NSEvent) {
        let held = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        pushToTalkTask?.cancel()
        guard held == .control, state.mode == .expanded else {
            if state.pushToTalk { state.pushToTalk = false }
            return
        }
        pushToTalkTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            self?.state.pushToTalk = true
        }
    }

    private func addMonitor(_ monitor: Any?) {
        if let monitor { monitors.append(monitor) }
    }

    private func pointerMoved() {
        let pointer = NSEvent.mouseLocation
        switch state.mode {
        case .collapsed, .peek:
            // The panel only takes the mouse over the pills, their preview and a session's banner, so they can be clicked and
            // the menu bar stays usable.
            updatePreview()
            panel.ignoresMouseEvents = !(pointerOnPills || pointerOnPreview || pointerOnPeek)
            // A little slack below the shape makes it easy to reach.
            if settings.openOnHover && shapeFrame(state.currentSize).insetBy(dx: -6, dy: -6).contains(pointer) {
                // In Music mode a session's banner opens on its session, which the music would hide.
                if state.mode == .peek, let session = state.peekSession, state.content.saved == .music {
                    open(session: session.id, byHover: true)
                } else {
                    expand(byHover: true)
                }
            }
        case .expanded:
            if shapeFrame(NotchState.expandedSize).insetBy(dx: -24, dy: -24).contains(pointer) {
                collapseTask?.cancel()
                collapseTask = nil
                // Back over a pinned notch that stepped behind other windows: bring it forward again.
                if !isRaised && !behindFloatingWindow && shapeFrame(state.notchSize).insetBy(dx: -6, dy: -6).contains(pointer) {
                    panel.level = NotchPanel.raisedLevel
                }
            } else if openedByHover && !state.pinned && !isTyping && collapseTask == nil {
                collapseTask = Task { [weak self] in
                    try? await Task.sleep(for: .milliseconds(450))
                    guard let self, !Task.isCancelled else { return }
                    self.collapseTask = nil
                    self.collapse()
                }
            }
        }
    }

    /// Opens the notch on the session whose pill was clicked; the `+N` pill opens it as it was. Returns false between pills.
    private func clickedPill() -> Bool {
        guard let index = state.pills.pill(at: NSEvent.mouseLocation.x - pillsFrame.minX) else { return false }
        _ = openPill(index)
        return true
    }

    /// Always nil: the click is used up.
    private func openPill(_ index: Int) -> NSEvent? {
        open(session: index < state.pills.sessions.count ? state.pills.sessions[index].id : nil)
        return nil
    }

    /// Shows the preview of the session pill the pointer rests on, keeps it while the pointer is on the card, and hides it
    /// otherwise.
    private func updatePreview() {
        if pointerOnPreview { return }
        guard pointerOnPills else { return hidePreview() }
        // Between two pills: whatever shows stays, so moving along the row doesn't flicker.
        guard let index = pillUnderPointer else { return }
        guard index < state.pills.sessions.count else { return hidePreview() }
        if state.previewPill == index { return }
        if state.previewPill != nil {
            // Already showing one: moving along the pills switches at once.
            withAnimation(.easeOut(duration: 0.12)) { state.previewPill = index }
            return
        }
        previewTask?.cancel()
        previewTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard let self, !Task.isCancelled, pillUnderPointer == index else { return }
            withAnimation(.easeOut(duration: 0.12)) { self.state.previewPill = index }
        }
    }

    private func hidePreview() {
        previewTask?.cancel()
        previewTask = nil
        guard state.previewPill != nil else { return }
        withAnimation(.easeOut(duration: 0.12)) { state.previewPill = nil }
    }

    /// Clicks in floating panels (launchers, Spotlight) are ignored: picking a clipboard item must not close the chat it pastes into.
    private func clickedOutside() {
        let pointer = NSEvent.mouseLocation
        guard state.mode == .expanded, !state.pinned, !shapeFrame(NotchState.expandedSize).contains(pointer) else { return }
        // The panel may already be gone when this runs: the last check of the watch counts too.
        guard !behindFloatingWindow, !FloatingWindows.contain(pointer) else { return }
        collapse()
    }

    /// Escape closes; ⌘M goes from the sessions to the music and back; ⌘1…⌘9 jump to a session in list order, pinned ones
    /// first; ⌘↑ and ⌘↓ move through the list; ⌘. stops the selected session while it works, like Escape in its terminal.
    private func handleKey(_ event: NSEvent) -> Bool {
        if state.menu != nil, menuKey(event) { return true }
        if event.keyCode == UInt16(kVK_Escape) {
            // Escape closes the palette or the new session panel first, then the notch.
            if state.showPalette {
                state.showPalette = false
            } else if state.showNewSession {
                state.showNewSession = false
            } else {
                collapse(force: true)
            }
            return true
        }
        // Space over an attachment previews it, unless it would go into a message being typed.
        if event.keyCode == UInt16(kVK_Space), event.modifierFlags.intersection(.deviceIndependentFlagsMask).isEmpty,
            let preview = state.quickLookUnderPointer, (state.drafts[store.selectedId ?? ""] ?? "").isEmpty
        {
            preview()
            return true
        }
        guard event.modifierFlags.contains(.command) else { return false }
        if event.charactersIgnoringModifiers == "k" {
            state.showPalette.toggle()
            return true
        }
        // ⌥⌘N is the default shortcut that opens the notch.
        if event.charactersIgnoringModifiers == "n", !event.modifierFlags.contains(.option), settings.isConfigured {
            state.showPalette = false
            state.showNewSession.toggle()
            return true
        }
        if event.charactersIgnoringModifiers == "m", event.modifierFlags.isDisjoint(with: [.option, .control]) {
            state.showPalette = false
            withAnimation(.easeOut(duration: 0.15)) { state.content = state.content.toggled() }
            return true
        }
        // The palette's own arrows move its selection, and the panel's field its cursor.
        if state.showPalette || state.showNewSession { return false }
        if event.charactersIgnoringModifiers == "." {
            // Not a session the music hides.
            guard state.content.shown == .sessions, let session = store.selected, session.accepts(.interrupt) else { return false }
            store.sendCommand(.interrupt, to: session.id)
            return true
        }
        let sessions = store.navigableSessions
        guard !sessions.isEmpty else { return false }
        if let digit = event.charactersIgnoringModifiers.flatMap(Int.init), (1...9).contains(digit) {
            if digit <= sessions.count {
                store.selectedId = sessions[digit - 1].id
                state.showHero = false
                state.visitSessions()
            }
            return true
        }
        let index = sessions.firstIndex { $0.id == store.selectedId } ?? 0
        switch Int(event.keyCode) {
        case kVK_UpArrow: store.selectedId = sessions[max(0, index - 1)].id
        case kVK_DownArrow: store.selectedId = sessions[min(sessions.count - 1, index + 1)].id
        default: return false
        }
        state.visitSessions()
        return true
    }

    /// An open dropdown takes Escape, the arrows and Return, as a menu does; any other key closes it and goes on.
    private func menuKey(_ event: NSEvent) -> Bool {
        switch Int(event.keyCode) {
        case kVK_Escape: state.menu = nil
        case kVK_UpArrow: state.menu?.move(by: -1)
        case kVK_DownArrow: state.menu?.move(by: 1)
        case kVK_Return, kVK_ANSI_KeypadEnter, kVK_Space:
            guard let item = state.menu?.highlightedItem else { return true }
            state.menu = nil
            item.action()
        default:
            state.menu = nil
            return false
        }
        return true
    }
}
