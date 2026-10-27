import SwiftUI
import TontonCore

struct SessionListView: View {
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var state: NotchState
    @State private var query = ""

    var body: some View {
        let sessions = store.visibleSessions.filter { $0.matches(query) }
        // The tool of each session only says something when both are listed.
        let mixed = store.visibleSessions.mixesTools
        let sections = SessionLayout.sections(sessions, pinned: settings.pinnedSessions, thisMac: store.thisMachines)
        VStack(spacing: 0) {
            if store.hasSessions {
                HStack(spacing: 4) {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass").font(.system(size: 10)).foregroundStyle(.secondary)
                        TextField("", text: $query, prompt: Text("Search sessions and messages").foregroundStyle(Theme.ink.opacity(0.35)))
                            .textFieldStyle(.plain)
                            .font(.system(size: 11))
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 26)
                    .background(RoundedRectangle(cornerRadius: 7).fill(Theme.ink.opacity(0.07)))
                    finishedToggle
                }
                .padding(.trailing, 6)
                .padding(.bottom, 4)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2, pinnedViews: []) {
                    ForEach(sections, id: \.kind) { section in
                        header(section)
                        ForEach(Array(section.sessions.enumerated()), id: \.element.id) { index, s in
                            let pinned = section.kind == .pinned
                            SessionRow(
                                session: s, selected: s.id == store.selectedId, showCost: settings.showCosts,
                                continues: store.autoContinue.contains(s.id),
                                snoozed: store.isSnoozed(s.id),
                                machine: pinned ? (store.isOnThisMac(s) ? "This Mac" : s.machine) : nil,
                                machineStyle: settings.machineStyles[s.machineId],
                                // Pinned sessions lead the list, so their place is their ⌘ shortcut unless a search hides some.
                                shortcut: pinned && query.isEmpty && index < 9 ? index + 1 : nil,
                                tool: mixed ? s.codingTool : nil
                            )
                            .contentShape(Rectangle())
                            .onTapGesture { store.selectedId = s.id }
                            .contextMenu {
                                Button(pinned ? "Unpin" : "Pin to top") { store.togglePin(s.id) }
                                if s.canChat {
                                    Toggle("Continue when the limit resets", isOn: autoContinue(s.id))
                                }
                                SnoozeMenu(sessionId: s.id)
                                if store.isOnThisMac(s) { LocalFolderActions(session: s, style: .menu) }
                                Divider()
                                Button("Remove from list") { store.dismiss(s.id) }
                            }
                        }
                    }
                    if query.count >= ConversationSearch.minimumQueryLength { messageResults }
                }
                .padding(.trailing, 6)
            }
            .scrollIndicators(.never)
        }
        // The relay only sends the conversations the app opens: a search fetches the others first.
        .onChange(of: query.count >= ConversationSearch.minimumQueryLength) { _, searching in
            if searching { store.catchUpHistories() }
        }
    }

    /// Hides the closed and offline sessions at once, or brings back the delay chosen in Settings › General.
    private var finishedToggle: some View {
        let hidden = settings.hideFinishedAfterHours == FinishedSessions.rightAway
        let count = store.hiddenFinishedCount
        return Button {
            let previous = UserDefaults.standard.object(forKey: "hideFinishedBeforeToggle") as? Int ?? 0
            if !hidden { UserDefaults.standard.set(settings.hideFinishedAfterHours, forKey: "hideFinishedBeforeToggle") }
            settings.hideFinishedAfterHours = FinishedSessions.toggled(settings.hideFinishedAfterHours, previous: previous)
        } label: {
            HStack(spacing: 3) {
                Image(systemName: hidden ? "eye.slash" : "eye").font(.system(size: 10))
                if hidden && count > 0 { Text("\(count)").font(.system(size: 9, weight: .semibold)).monospacedDigit() }
            }
            .frame(minWidth: 26, minHeight: 26)
            .background(RoundedRectangle(cornerRadius: 7).fill(hidden ? Theme.accent.opacity(0.16) : Theme.ink.opacity(0.07)))
            .foregroundStyle(hidden ? Theme.accent : .secondary)
        }
        .buttonStyle(.plain)
        .help(hidden ? "Show the finished sessions (\(count) hidden)" : "Hide the closed and offline sessions")
        .accessibilityLabel(hidden ? "Show finished sessions" : "Hide finished sessions")
    }

    /// Messages that match the search, in every conversation the app has open: a click shows the message in its session.
    @ViewBuilder private var messageResults: some View {
        let matches = ConversationSearch.search(query, sessions: store.orderedSessions, entries: store.entries)
        let projects = Dictionary(store.sessions.map { ($0.id, $0.project) }) { first, _ in first }
        Text("MESSAGES").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary).padding(.horizontal, 8).padding(.top, 10)
        if matches.isEmpty {
            Text("Nothing found in the conversations opened since Tonton Claude started, or on this Mac.")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 8)
        }
        ForEach(matches) { match in
            VStack(alignment: .leading, spacing: 2) {
                Text(projects[match.sessionId] ?? "").font(.system(size: 11, weight: .semibold)).lineLimit(1)
                Text(match.snippet).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
            .onTapGesture {
                store.selectedId = match.sessionId
                state.jumpTo = match.itemId
            }
        }
    }

    private func autoContinue(_ sessionId: String) -> Binding<Bool> {
        Binding(get: { store.autoContinue.contains(sessionId) }, set: { _ in store.toggleAutoContinue(sessionId) })
    }

    @ViewBuilder private func header(_ section: SessionSection) -> some View {
        HStack(spacing: 4) {
            switch section.kind {
            case .pinned:
                Image(systemName: "pin.fill").font(.system(size: 8)).foregroundStyle(.secondary)
                Text("PINNED").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                Spacer(minLength: 4)
            case .thisMac:
                if let style = store.thisMac.flatMap({ settings.machineStyles[$0] }), !style.isEmpty {
                    MachineBadge(style: style, size: 9)
                } else {
                    Image(systemName: "laptopcomputer").font(.system(size: 9)).foregroundStyle(.secondary)
                }
                Text("THIS MAC").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if let info = store.machines.first(where: { $0.id == store.thisMac }) { NotchAgentUpdate(machine: info) }
            case .machine(let machine):
                if let style = section.sessions.first.flatMap({ settings.machineStyles[$0.machineId] }) {
                    MachineBadge(style: style, size: 9)
                }
                Text(machine.uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if let info = store.machines.first(where: { $0.id == section.sessions.first?.machineId }) {
                    NotchAgentUpdate(machine: info)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
    }
}

/// Shown next to a machine's name when its agent is out of date.
struct NotchAgentUpdate: View {
    let machine: MachineInfo
    @EnvironmentObject var store: SessionStore

    var body: some View {
        switch machine.agentUpdate(to: store.agentVersion) {
        case .oneClick:
            if store.updatingMachines.contains(machine.id) {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini)
                    Text("Updating").font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
                }
            } else {
                pill("Update agent") { store.updateAgent(machine) }
                    .help("Install agent \(store.agentVersion ?? "") on \(machine.name)")
            }
        case .manual:
            pill("Update agent") { AppDelegate.shared?.showSettings(pane: .machines) }
                .help("This agent is too old to update from here: Settings › Machines gives the command to run once on \(machine.name)")
        case nil:
            EmptyView()
        }
    }

    private func pill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 9))
                Text(title).font(.system(size: 9, weight: .semibold))
            }
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Theme.accent.opacity(0.16)))
        }
        .buttonStyle(.plain)
    }
}

struct SessionRow: View {
    let session: SessionSummary
    let selected: Bool
    var showCost = false
    /// Gets `continue` when the limit that stopped it resets.
    var continues = false
    /// Its alerts are muted for a while.
    var snoozed = false
    /// Shown in the pinned section, where sessions from every machine sit together.
    var machine: String?
    var machineStyle: MachineStyle?
    var shortcut: Int?
    /// Shown when the list has sessions of both tools.
    var tool: CodingTool?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            StatusDot(status: session.status, limit: session.fiveHourLimit).padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    if let tool { ToolMark(tool: tool, size: 9) }
                    Text(session.project).font(.system(size: 12, weight: .semibold)).lineLimit(1).layoutPriority(1)
                    if let machine {
                        if let machineStyle { MachineBadge(style: machineStyle, size: 9) }
                        Text(machine).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    if let shortcut {
                        Text("⌘\(shortcut)").font(.system(size: 9, weight: .medium)).foregroundStyle(.tertiary)
                    }
                    if snoozed {
                        Image(systemName: "bell.slash").font(.system(size: 9)).foregroundStyle(.tertiary)
                            .help("Alerts snoozed: permission requests still come through")
                            .accessibilityLabel("Alerts snoozed")
                    }
                    if !session.pendingPermissions.isEmpty {
                        Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(Theme.accent)
                    }
                    Text(session.lastActivity, style: .relative)
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .frame(maxWidth: 70, alignment: .trailing)
                }
                HStack(alignment: .top, spacing: 6) {
                    Text(session.title ?? session.lastMessage ?? session.status.label)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                    if showCost, let cost = session.costUSD, cost > 0 {
                        Text(String(format: "$%.2f", cost)).font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
                    }
                }
                if session.status.needsAttention || session.status.isLive && session.limitToWatch() != nil {
                    // Re-read twice a minute: the countdown runs, and the limit disappears once it resets.
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        statusLine(at: context.date)
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 9).fill(selected ? Theme.ink.opacity(0.12) : .clear))
        .opacity(session.status.isLive ? 1 : 0.55)
    }

    /// What needs the user, then when a limit that stopped the session, or is about to, resets.
    @ViewBuilder private func statusLine(at now: Date) -> some View {
        let limit = session.status.isLive ? session.limitToWatch(at: now) : nil
        if session.status.needsAttention || limit != nil {
            let attention =
                session.status.needsAttention
                ? Text(session.displayStatusText).foregroundColor(Color(nsColor: session.status.color)) : Text("")
            let separator = session.status.needsAttention && limit != nil ? Text(" · ").foregroundColor(.secondary) : Text("")
            let countdown = limit.flatMap { limit in
                limit.level(at: now).map { level in
                    let verb = continues && session.stoppedUntil(at: now) != nil ? "continues" : "resets"
                    return Text("\(verb) in \(limit.timeLeft(at: now))").foregroundColor(level.color)
                }
            }
            (attention + separator + (countdown ?? Text("")))
                .font(.system(size: 10, weight: .medium))
                .lineLimit(1)
        }
    }
}

/// Which coding agent runs a session: Claude Code or OpenCode.
struct ToolMark: View {
    let tool: CodingTool
    var size: CGFloat = 10

    var body: some View {
        Image(systemName: tool.symbol)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(.secondary)
            .help(tool.label)
            .accessibilityLabel(tool.label)
    }
}
