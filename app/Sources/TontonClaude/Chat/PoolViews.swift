import AppKit
import SwiftUI
import TontonCore

// Pools in the notch (#234, docs/pools.md): a session's pool, its task and the pool's messages, putting a session in a
// pool (#219), and the tasks a session waits for its owner to accept. The logic is in TontonCore (PoolState, PoolJoin).

/// In the chat header: the session's pool, or a way to put it in one.
struct PoolButton: View {
    let session: SessionSummary
    @ObservedObject private var pools = PoolStore.shared
    @EnvironmentObject var state: NotchState

    var body: some View {
        let membership = pools.membership(of: session.id)
        let open = Binding(get: { state.poolOf == session.id }, set: { state.poolOf = $0 ? session.id : nil })
        Button {
            state.poolOf = state.poolOf == session.id ? nil : session.id
        } label: {
            HStack(spacing: 3) {
                Image(systemName: membership == nil ? "person.3" : "person.3.fill").font(.notch(11))
                if let membership {
                    Text(PoolLabels.role(of: membership.session, in: membership.state)).font(.notch(10, weight: .semibold)).lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(membership == nil ? Theme.secondary : AnyShapeStyle(Theme.accent))
        .help(
            membership.map { PoolLabels.hint($0.board.name, PoolLabels.task(of: session.id, in: $0.state)) }
                ?? String(localized: "Put this session in a pool")
        )
        .accessibilityLabel(membership.map { String(localized: "Pool \($0.board.name)") } ?? String(localized: "Join pool"))
        .popover(isPresented: open, arrowEdge: .bottom) {
            if let membership {
                PoolPanel(session: session, board: membership.board, state: membership.state, member: membership.session)
            } else {
                PoolJoinView(session: session)
            }
        }
    }
}

/// What the session does in its pool: how far the pool is, its task, the latest messages for it, and the way out.
struct PoolPanel: View {
    let session: SessionSummary
    let board: PoolBoard
    let state: PoolState
    let member: PoolState.Session
    @ObservedObject private var pools = PoolStore.shared
    @EnvironmentObject var notch: NotchState

    var body: some View {
        let tasks = state.tasks.filter { $0.task != nil }
        let done = tasks.filter { $0.task?.state == .done }.count
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                IconTile(systemName: "person.3.fill", tint: Theme.accent, size: 30).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(board.name).font(.notch(13, weight: .bold)).lineLimit(1).accessibilityAddTraits(.isHeader)
                    if let goal = state.info?.goal {
                        Text(goal).font(.notch(10.5)).foregroundStyle(Theme.secondary).lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                if state.paused { PoolChip(text: String(localized: "Paused"), systemImage: "pause.fill", tint: Theme.warning) }
                if let deadline = state.info?.deadline {
                    // A hackathon: the countdown moves while the panel is open.
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        PoolChip(
                            text: PoolHackathon.countdown(deadline, now: context.date) ?? "", systemImage: "timer",
                            tint: PoolHackathon.isLate(deadline, now: context.date) ? Theme.danger : Theme.accent)
                    }
                }
            }
            if !tasks.isEmpty {
                HStack(spacing: 8) {
                    PoolProgress(done: done, total: tasks.count)
                    Text(verbatim: "\(done)/\(tasks.count)").font(.notch(10, weight: .semibold)).foregroundStyle(Theme.tertiary)
                        .monospacedDigit()
                }
            }
            yourTask
            let messages = state.messages(of: session.id, limit: 8)
            if !messages.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(messages) { post in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(state.who(account: post.account, session: post.session)).font(.notch(9.5, weight: .semibold))
                                    .foregroundStyle(Theme.tertiary)
                                Text(post.body?.text ?? "").font(.notch(11)).textSelection(.enabled)
                            }
                            .padding(.horizontal, 9)
                            .padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 9).fill(Theme.raised))
                        }
                    }
                }
                .frame(maxHeight: 170)
            }
            PoolMachineButtons(poolId: board.id, role: board.summary.role, state: state, member: member)
            HStack(spacing: 6) {
                if let url = pools.websiteURL(of: board.id) {
                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        Label("Open the pool", systemImage: "safari")
                    }
                    .buttonStyle(NotchButtonStyle())
                    .help("Its plan, its tasks and its team, on the relay's website.")
                }
                if state.machine(of: member) == nil && (board.summary.role == .owner || board.summary.role == .admin) {
                    // A session put in by hand: an admin can still make it the orchestrator.
                    let leads = PoolLabels.leads(member, in: state)
                    Button(leads ? "Not the orchestrator" : "Make it the orchestrator") {
                        pools.setOrchestrator(
                            leads ? nil : PoolSessionRef(account: member.account, session: member.session), pool: board.id)
                    }
                    .buttonStyle(NotchButtonStyle())
                    .help(
                        leads
                            ? "The pool then has no orchestrator until you choose another one."
                            : "It plans the project and hands the tasks out.")
                }
                Spacer(minLength: 4)
                Button("Leave", role: .destructive) {
                    pools.leave(session.id, pool: board.id)
                    notch.poolOf = nil
                }
                .buttonStyle(NotchButtonStyle(kind: .destructive))
                .help("This session leaves the pool. You stay a member.")
            }
        }
        .padding(14)
        .frame(width: 340)
    }

    /// What this session is to the pool, and the task it works on.
    private var yourTask: some View {
        let task = state.currentTask(of: session.id)
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                PoolChip(
                    text: PoolLabels.role(of: member, in: state),
                    systemImage: PoolLabels.leads(member, in: state) ? "sparkles" : "hammer.fill")
                Spacer()
                HStack(spacing: 4) {
                    Circle().fill(member.ready ? Theme.success : Theme.warning).frame(width: 6, height: 6)
                    Text(member.ready ? String(localized: "Working for the pool") : String(localized: "Joining…"))
                        .font(.notch(10)).foregroundStyle(Theme.tertiary)
                }
                .help(member.ready ? "" : String(localized: "Waiting for its agent to take the order…"))
            }
            if let task = task?.task {
                Text(task.title).font(.notch(12, weight: .semibold)).lineLimit(2)
                Text(task.state.label).font(.notch(10)).foregroundStyle(Theme.tertiary)
            } else {
                Text(PoolLabels.leads(member, in: state) ? "It plans and hands out the work." : "No task yet")
                    .font(.notch(11)).foregroundStyle(Theme.secondary)
            }
        }
        .poolCard()
    }
}

/// In the pool panel (#260): the machine that started this session, and for the owner and admins every machine of the
/// pool. Stopped, a machine ends its pool sessions and takes no work until started again. The stops ask first, in the
/// panel itself: a popover is no place for a dialog.
struct PoolMachineButtons: View {
    let poolId: String
    let role: PoolRole
    let state: PoolState
    let member: PoolState.Session
    @ObservedObject private var pools = PoolStore.shared
    @State private var asking: Stop?

    private enum Stop { case machine, every }

    var body: some View {
        let all = state.machines ?? []
        let manages = role == .owner || role == .admin
        let machine = state.machine(of: member).flatMap { PoolState.mayStop($0, account: member.account, role: role) ? $0 : nil }
        let stops = manages && all.contains { !$0.stopped }
        let starts = manages && all.contains(where: \.stopped)
        if machine != nil || stops || starts {
            VStack(alignment: .leading, spacing: 6) {
                if let machine {
                    let name = machine.profile?.name ?? String(localized: "This machine")
                    // The orchestrator session goes on when its machine stops: the admin still talks to it.
                    let leads = PoolLabels.leads(member, in: state)
                    HStack(spacing: 6) {
                        Image(systemName: "desktopcomputer").font(.notch(10)).foregroundStyle(Theme.tertiary).accessibilityHidden(true)
                        Text(machine.stopped ? "\(name) is stopped" : "Started by \(name)").font(.notch(10.5)).lineLimit(1)
                        if let plan = machine.profile?.planLabel { PoolChip(text: plan, tint: Theme.textDim) }
                        Spacer(minLength: 4)
                        if machine.stopped {
                            Button("Start") { pools.stopMachine(machine.machine, stopped: false, pool: poolId) }
                                .buttonStyle(NotchButtonStyle())
                                .help("It takes the pool's tasks again.")
                        } else if asking != .machine {
                            Button("Stop") { asking = .machine }
                                .buttonStyle(NotchButtonStyle(kind: .destructive))
                                .help(
                                    leads
                                        ? "Its other pool sessions end, and their tasks go back to the board. This orchestrator session goes on."
                                        : "Its pool sessions end, this one too, and their tasks go back to the board.")
                        }
                    }
                    if asking == .machine && !machine.stopped {
                        ask("Stop \(name)? It takes no tasks until it is started again.", action: "Stop machine") {
                            pools.stopMachine(machine.machine, stopped: true, pool: poolId)
                        }
                    }
                }
                if stops || starts {
                    HStack(spacing: 6) {
                        Text("Every machine").font(.notch(10.5)).foregroundStyle(Theme.secondary)
                        Spacer(minLength: 4)
                        if starts {
                            Button("Start all") { pools.stopEveryMachine(false, pool: poolId) }
                                .buttonStyle(NotchButtonStyle())
                                .help("The dispatch stays as it is: turn it on from the website, or ask the orchestrator.")
                        }
                        if stops && asking != .every {
                            Button("Stop all") { asking = .every }
                                .buttonStyle(NotchButtonStyle(kind: .destructive))
                                .help("The dispatch stops, and every machine ends its pool sessions.")
                        }
                    }
                    if asking == .every {
                        ask(
                            "Stop every machine? The dispatch stops, and their pool sessions end. Nothing starts again until you start the machines and the dispatch.",
                            action: "Stop every machine"
                        ) { pools.stopEveryMachine(true, pool: poolId) }
                    }
                }
            }
            .poolCard(padding: 9)
        }
    }

    private func ask(_ question: LocalizedStringKey, action: LocalizedStringKey, _ confirm: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(question).font(.notch(11)).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Spacer()
                Button("Cancel") { asking = nil }.buttonStyle(NotchButtonStyle())
                Button(action, role: .destructive) {
                    confirm()
                    asking = nil
                }
                .buttonStyle(NotchButtonStyle(kind: .destructive))
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.danger.opacity(0.1)))
    }
}

/// Puts the session in one of the account's pools in a click: the pool, an area if the owner wants one, and Join. What
/// it is (its tool, model and folder) goes with it; the rest is a click further.
struct PoolJoinView: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var notch: NotchState
    @ObservedObject private var pools = PoolStore.shared
    @State private var form: PoolJoinForm
    @State private var poolId: String?
    @State private var more = false
    @State private var error: String?
    /// Owner and admins: make the session the pool's orchestrator once it joins.
    @State private var lead = false

    init(session: SessionSummary) {
        self.session = session
        _form = State(initialValue: PoolJoinForm(session: session))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                IconTile(systemName: "person.3", tint: Theme.accent, size: 30).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Put this session in a pool").font(.notch(13, weight: .bold)).accessibilityAddTraits(.isHeader)
                    // The pool it joins when the account has one, then what the session runs.
                    Text(
                        verbatim: ([
                            pools.joinable.count == 1 ? pools.joinable.first?.name : nil, session.codingTool.label, session.modelName,
                        ]
                        .compactMap { $0 }).joined(separator: " · ")
                    )
                    .font(.notch(10.5)).foregroundStyle(Theme.tertiary).lineLimit(1)
                }
            }
            if let why = store.whyNotPool(session) {
                Text(why).font(.notch(11)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            } else if pools.joinable.isEmpty {
                Text(pools.problem ?? String(localized: "This account is in no pool yet. Make one or join one on the relay's website."))
                    .font(.notch(11)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                fields
            }
        }
        .padding(14)
        .frame(width: 340)
        .task { await pools.refresh() }
    }

    private var selected: PoolBoard? {
        let id = poolId ?? pools.joinable.first?.id
        return pools.joinable.first { $0.id == id }
    }

    private var canLead: Bool { selected.map { $0.summary.role == .owner || $0.summary.role == .admin } ?? false }

    /// The areas to pick from: a hackathon's roles, else the usual ones.
    private var areas: [String] {
        if let state = selected?.state, state.info?.isHackathon == true { return PoolHackathon.joinRoles(of: state) }
        return PoolJoinForm.areas
    }

    /// Puts the session in the pool, and makes it the orchestrator when asked.
    private func join() {
        guard let pool = selected?.id else { return }
        do {
            try pools.join(session, pool: pool, form: form)
            // Sent after the join on the same socket: the relay knows the session by then.
            if lead && canLead { pools.setOrchestrator(pools.ref(of: session.id), pool: pool) }
            notch.poolOf = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    @ViewBuilder private var fields: some View {
        if pools.joinable.count > 1 {
            section("Pool") {
                FlowLayout {
                    ForEach(pools.joinable, id: \.id) { board in
                        PoolChoice(title: board.name, picked: board.id == selected?.id) { poolId = board.id }
                    }
                }
            }
        }
        if let left = selected?.state?.info?.deadline.flatMap({ PoolHackathon.countdown($0) }) {
            PoolChip(text: left, systemImage: "timer")
        }
        section("Area, if you want one") {
            FlowLayout {
                PoolChoice(title: String(localized: "Any"), picked: form.area.isEmpty) { form.area = "" }
                ForEach(areas, id: \.self) { area in
                    PoolChoice(title: PoolHackathon.roleLabel(area), picked: form.area == area) { form.area = area }
                }
            }
        }
        VStack(spacing: 8) {
            Toggle(isOn: $form.autoStart) {
                Text("Start its pool tasks without asking me").font(.notch(11))
            }
            .toggleStyle(AccentToggleStyle())
            .help("Off: the notch asks you before the session starts a task the pool gives it. Permission prompts come to you either way.")
            if canLead {
                Toggle(isOn: $lead) {
                    Text("Make it the pool's orchestrator").font(.notch(11))
                }
                .toggleStyle(AccentToggleStyle())
                .help("It plans the project and hands the tasks to the others, instead of taking tasks itself.")
            }
        }
        if more {
            VStack(alignment: .leading, spacing: 6) {
                ThemeField(placeholder: "What it knows, in a few words", text: $form.skills)
                ThemeField(placeholder: "Repository folder", text: $form.repo)
            }
        }
        if let error { Text(error).font(.notch(10)).foregroundStyle(Theme.danger) }
        HStack {
            if !more {
                Button("More…") { more = true }
                    .buttonStyle(.plain)
                    .font(.notch(10.5))
                    .foregroundStyle(Theme.tertiary)
            }
            Spacer()
            Button {
                join()
            } label: {
                Label("Join the pool", systemImage: "arrow.right")
            }
            .buttonStyle(NotchButtonStyle(kind: .primary))
            .keyboardShortcut(.defaultAction)
        }
    }

    private func section<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.notch(10, weight: .semibold)).foregroundStyle(Theme.tertiary)
            content()
        }
    }
}

/// In the session row: the session works in a pool. Its role and task are in the tooltip, and on the header's button:
/// the row is narrow, its name goes first.
struct PoolMark: View {
    let sessionId: String
    @ObservedObject private var pools = PoolStore.shared

    var body: some View {
        if let membership = pools.membership(of: sessionId) {
            Image(systemName: "person.3.fill").font(.notch(8))
                .foregroundStyle(Theme.tertiary)
                .help(
                    PoolLabels.hint(
                        membership.board.name,
                        "\(PoolLabels.role(of: membership.session, in: membership.state)) · \(PoolLabels.task(of: sessionId, in: membership.state))"
                    )
                )
                .accessibilityLabel("In pool \(membership.board.name)")
        }
    }
}

/// Above the conversation: the tasks the pool gave the session, which wait for its owner to accept them.
struct PoolTaskCards: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @ObservedObject private var pools = PoolStore.shared

    var body: some View {
        if let membership = pools.membership(of: session.id) {
            // The orchestrator's plan, above its conversation, where its owner talks to it.
            if PoolLabels.leads(membership.session, in: membership.state), let plan = membership.state.pendingPlan {
                PoolPlanCard(board: membership.board, state: membership.state, plan: plan)
            }
            ForEach(membership.state.waitingTasks(of: session.id)) { item in
                if let task = item.task {
                    PoolTaskCard(
                        task: task, from: membership.state.who(account: item.account, session: item.session), pool: membership.board.name,
                        accept: {
                            store.sendPrompt(PoolLinks.acceptPrompt(taskId: item.id, title: task.title), images: [], to: session.id)
                        },
                        refuse: {
                            pools.refuse(item, pool: membership.board.id)
                            store.sendPrompt(PoolLinks.refusePrompt(taskId: item.id, title: task.title), images: [], to: session.id)
                        })
                }
            }
        }
    }
}

struct PoolTaskCard: View {
    let task: PoolTask
    let from: String
    let pool: String
    let accept: () -> Void
    let refuse: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: "person.3.fill").foregroundStyle(Theme.accent).accessibilityHidden(true)
                Text("Pool task from \(from)").font(.notch(11, weight: .semibold)).foregroundStyle(Theme.secondary).lineLimit(1)
                Spacer()
                Text(pool).font(.notch(10)).foregroundStyle(Theme.tertiary).lineLimit(1)
            }
            Text(task.title).font(.notch(12, weight: .bold)).accessibilityAddTraits(.isHeader)
            if let goal = task.goal { Text(goal).font(.notch(11)).foregroundStyle(Theme.secondary).lineLimit(4) }
            if let criteria = task.criteria, !criteria.isEmpty {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(criteria.prefix(5).enumerated()), id: \.offset) { _, line in
                        Text(verbatim: "• \(line)").font(.notch(10)).foregroundStyle(Theme.secondary).lineLimit(2)
                    }
                }
            }
            HStack(spacing: 6) {
                Spacer()
                Button("Refuse", action: refuse).buttonStyle(NotchButtonStyle())
                Button(action: accept) { Label("Accept", systemImage: "checkmark") }
                    .buttonStyle(NotchButtonStyle(kind: .primary))
            }
        }
        .poolCard(highlighted: true)
        .help("The session asks you first before it starts a pool task. Refuse puts it back on the pool's board.")
    }
}

/// The words the pool views share.
enum PoolLabels {
    static func role(of session: PoolState.Session, in pool: PoolState) -> String {
        leads(session, in: pool) ? String(localized: "orchestrator") : session.profile?.area ?? String(localized: "pool")
    }

    /// The session is the pool's orchestrator.
    static func leads(_ session: PoolState.Session, in pool: PoolState) -> Bool {
        pool.orchestrator?.account == session.account && pool.orchestrator?.session == session.session
    }

    /// `Hackathon: Build the API`, never translated.
    static func hint(_ pool: String, _ task: String) -> String { pool + ": " + task }

    static func task(of sessionId: String, in state: PoolState) -> String {
        state.currentTask(of: sessionId)?.task?.title ?? String(localized: "No task yet")
    }
}
