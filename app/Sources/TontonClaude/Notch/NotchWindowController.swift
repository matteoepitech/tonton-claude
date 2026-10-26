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
    private var collapseTask: Task<Void, Never>?
    private var overlapTask: Task<Void, Never>?
    private var behindFloatingWindow = false
    private var peekTask: Task<Void, Never>?
    private var openedByHover = false
    /// The last other app in front, given back the focus when the notch closes.
    private var previousApp: NSRunningApplication?

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

    /// Frame of the visible shape, in screen coordinates.
    private func shapeFrame(_ size: CGSize) -> NSRect {
        NSRect(x: panel.frame.midX - size.width / 2, y: panel.frame.maxY - size.height, width: size.width, height: size.height)
    }

    // MARK: Opening and closing

    func expand(byHover: Bool = false) {
        peekTask?.cancel()
        collapseTask?.cancel()
        if state.mode != .expanded { openedByHover = byHover }
        panel.level = NotchPanel.raisedLevel
        withAnimation(.spring(response: 0.38, dampingFraction: 0.82)) { state.mode = .expanded }
        takeFocus()
        watchFloatingWindows()
    }

    /// `force` also closes a pinned notch (escape, opening the settings) and unpins it.
    func collapse(force: Bool = false) {
        collapseTask?.cancel()
        if force { state.pinned = false }
        state.showSearch = false
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
        guard !settings.isQuietNow else { return }
        signal()
        if settings.systemNotifications { Notifier.post(session, body: finished ? "Claude is done." : session.displayStatusText) }
        if settings.openOnPermission && session.status == .permission {
            store.selectedId = session.id
            expand()
        } else {
            peek(session)
        }
    }

    /// Sessions a usage limit stopped can go again: the same sound and banner, once for all of them.
    private func limitLifted(_ sessions: [SessionSummary]) {
        guard let session = sessions.first, !settings.isQuietNow else { return }
        signal()
        if settings.systemNotifications {
            let more = sessions.count > 1 ? " \(sessions.count) sessions can go again." : " Claude can go again."
            Notifier.post(session, body: "The usage limit reset." + more)
        }
        peek(session, text: "Usage limit reset")
    }

    private func signal() {
        if settings.soundOnAttention { NSSound(named: settings.alertSound)?.play() }
        if settings.haptics { NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .now) }
    }

    /// `text` replaces the session's status in the banner.
    private func peek(_ session: SessionSummary, text: String? = nil) {
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
        store.attention
            .sink { [weak self] session in self?.alert(session, finished: false) }
            .store(in: &subscriptions)
        store.finished
            .filter { [settings] _ in settings.alertOnFinish }
            .sink { [weak self] session in self?.alert(session, finished: true) }
            .store(in: &subscriptions)
        store.limitLifted
            .filter { [settings] _ in settings.alertOnLimitReset }
            .sink { [weak self] sessions in self?.limitLifted(sessions) }
            .store(in: &subscriptions)
        store.sessionsPublisher.combineLatest(settings.$showActivityDots, settings.$hiddenMachines)
            .map { sessions, dots, hidden in dots && sessions.contains { $0.status.isLive && !hidden.contains($0.machine) } }
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
                if let self, self.state.mode == .expanded, event.window === self.panel { self.openedByHover = false }
                return event
            })
        addMonitor(
            NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.state.mode == .expanded, event.window === self.panel else { return event }
                if self.handleKey(event) { return nil }
                self.openedByHover = false
                return event
            })
    }

    private func addMonitor(_ monitor: Any?) {
        if let monitor { monitors.append(monitor) }
    }

    private func pointerMoved() {
        let pointer = NSEvent.mouseLocation
        switch state.mode {
        case .collapsed, .peek:
            // A little slack below the shape makes it easy to reach.
            if settings.openOnHover && shapeFrame(state.currentSize).insetBy(dx: -6, dy: -6).contains(pointer) {
                expand(byHover: true)
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

    /// Clicks in floating panels (launchers, Spotlight) are ignored: picking a clipboard item must not close the chat it pastes into.
    private func clickedOutside() {
        let pointer = NSEvent.mouseLocation
        guard state.mode == .expanded, !state.pinned, !shapeFrame(NotchState.expandedSize).contains(pointer) else { return }
        // The panel may already be gone when this runs: the last check of the watch counts too.
        guard !behindFloatingWindow, !FloatingWindows.contain(pointer) else { return }
        collapse()
    }

    /// Escape closes; ⌘1…⌘9 jump to a session in list order, pinned ones first; ⌘↑ and ⌘↓ move through the list.
    private func handleKey(_ event: NSEvent) -> Bool {
        if event.keyCode == UInt16(kVK_Escape) {
            // Escape closes the search first, then the notch.
            if state.showSearch { state.showSearch = false } else { collapse(force: true) }
            return true
        }
        guard event.modifierFlags.contains(.command) else { return false }
        if event.charactersIgnoringModifiers == "f" {
            state.showSearch.toggle()
            if state.showSearch { store.loadHistories() }
            return true
        }
        // The search's own arrows move its selection.
        if state.showSearch { return false }
        let sessions = store.orderedSessions
        guard !sessions.isEmpty else { return false }
        if let digit = event.charactersIgnoringModifiers.flatMap(Int.init), (1...9).contains(digit) {
            if digit <= sessions.count { store.selectedId = sessions[digit - 1].id }
            return true
        }
        let index = sessions.firstIndex { $0.id == store.selectedId } ?? 0
        switch Int(event.keyCode) {
        case kVK_UpArrow: store.selectedId = sessions[max(0, index - 1)].id
        case kVK_DownArrow: store.selectedId = sessions[min(sessions.count - 1, index + 1)].id
        default: return false
        }
        return true
    }
}
