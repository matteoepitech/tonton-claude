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
                if let membership { Text(PoolLabels.role(of: membership.session)).font(.notch(10, weight: .semibold)).lineLimit(1) }
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

/// What the session does in its pool, the pool's latest messages for it, and the way out.
struct PoolPanel: View {
    let session: SessionSummary
    let board: PoolBoard
    let state: PoolState
    let member: PoolState.Session
    @ObservedObject private var pools = PoolStore.shared
    @EnvironmentObject var notch: NotchState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "person.3.fill").foregroundStyle(Theme.accent).accessibilityHidden(true)
                Text(board.name).font(.notch(13, weight: .bold)).lineLimit(1).accessibilityAddTraits(.isHeader)
                if state.paused { Text("Paused").font(.notch(10, weight: .semibold)).foregroundStyle(Theme.warning) }
                Spacer()
            }
            if let goal = state.info?.goal { Text(goal).font(.notch(11)).foregroundStyle(Theme.secondary).lineLimit(3) }
            VStack(alignment: .leading, spacing: 3) {
                row("Role", PoolLabels.role(of: member))
                row("Takes", PoolTaskSize.of(member.profile, tool: session.codingTool).label)
                row("Task", PoolLabels.task(of: session.id, in: state))
                row(
                    "Agent",
                    member.ready ? String(localized: "Working for the pool") : String(localized: "Waiting for its agent to take the order…")
                )
            }
            let messages = state.messages(of: session.id, limit: 8)
            if !messages.isEmpty {
                Text("Messages").font(.notch(11, weight: .semibold)).padding(.top, 4)
                ScrollView {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(messages) { post in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(state.who(account: post.account, session: post.session)).font(.notch(10, weight: .semibold))
                                    .foregroundStyle(Theme.tertiary)
                                Text(post.body?.text ?? "").font(.notch(11)).textSelection(.enabled)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .frame(maxHeight: 160)
            }
            HStack {
                if let url = pools.websiteURL(of: board.id) {
                    Button("Open on the website") { NSWorkspace.shared.open(url) }
                }
                Spacer()
                Button("Leave pool", role: .destructive) {
                    pools.leave(session.id, pool: board.id)
                    notch.poolOf = nil
                }
            }
            .font(.notch(11))
            .padding(.top, 4)
        }
        .padding(12)
        .frame(width: 320)
    }

    private func row(_ title: LocalizedStringKey, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).font(.notch(10, weight: .semibold)).foregroundStyle(Theme.tertiary).frame(width: 44, alignment: .leading)
            Text(value).font(.notch(11)).lineLimit(2)
        }
    }
}

/// Puts the session in one of the account's pools, with what the pool should know of it.
struct PoolJoinView: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var notch: NotchState
    @ObservedObject private var pools = PoolStore.shared
    @State private var form: PoolJoinForm
    @State private var poolId: String?
    @State private var error: String?

    init(session: SessionSummary) {
        self.session = session
        _form = State(initialValue: PoolJoinForm(session: session))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Join a pool").font(.notch(13, weight: .bold)).accessibilityAddTraits(.isHeader)
            if let why = store.whyNotPool(session) {
                Text(why).font(.notch(11)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            } else if pools.joinable.isEmpty {
                Text(pools.problem ?? String(localized: "This account is in no pool yet. Make one or join one on the relay's website."))
                    .font(.notch(11)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                fields
            }
        }
        .padding(12)
        .frame(width: 320)
        .task { await pools.refresh() }
    }

    @ViewBuilder private var fields: some View {
        Picker("Pool", selection: Binding(get: { poolId ?? pools.joinable.first?.id }, set: { poolId = $0 })) {
            ForEach(pools.joinable, id: \.id) { board in Text(board.name).tag(Optional(board.id)) }
        }
        HStack(spacing: 4) {
            TextField("Area: front, back, infra…", text: $form.area).textFieldStyle(.roundedBorder)
            Menu {
                ForEach(PoolJoinForm.areas, id: \.self) { area in Button(area) { form.area = area } }
            } label: {
                Image(systemName: "chevron.down")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel("Pick an area")
        }
        TextField("What it knows, in a few words", text: $form.skills).textFieldStyle(.roundedBorder)
        TextField("Repository folder", text: $form.repo).textFieldStyle(.roundedBorder)
        Text(verbatim: "\(session.codingTool.label)\(session.modelName.map { " · \($0)" } ?? "")").font(.notch(10)).foregroundStyle(
            Theme.tertiary)
        Picker("Gives it", selection: $form.takes) {
            ForEach(PoolTaskSize.allCases) { size in Text(size.label).tag(size) }
        }
        Toggle("Start pool tasks right away", isOn: $form.autoStart)
            .help("Off: the notch asks you before the session starts a task the pool gives it.")
        if let error { Text(error).font(.notch(10)).foregroundStyle(Theme.danger) }
        HStack {
            Spacer()
            Button("Join pool") {
                guard let pool = poolId ?? pools.joinable.first?.id else { return }
                do {
                    try pools.join(session, pool: pool, form: form)
                    notch.poolOf = nil
                } catch {
                    self.error = error.localizedDescription
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
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
                        "\(PoolLabels.role(of: membership.session)) · \(PoolLabels.task(of: sessionId, in: membership.state))")
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
            HStack {
                Spacer()
                Button("Refuse", action: refuse)
                Button("Accept", action: accept).buttonStyle(.borderedProminent).tint(Theme.accent)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.accent.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.3)))
        .help("The session asks you first before it starts a pool task. Refuse puts it back on the pool's board.")
    }
}

/// The words the pool views share.
enum PoolLabels {
    static func role(of session: PoolState.Session) -> String {
        session.profile?.orchestrator == true ? String(localized: "orchestrator") : session.profile?.area ?? String(localized: "pool")
    }

    /// `Hackathon: Build the API`, never translated.
    static func hint(_ pool: String, _ task: String) -> String { pool + ": " + task }

    static func task(of sessionId: String, in state: PoolState) -> String {
        state.currentTask(of: sessionId)?.task?.title ?? String(localized: "No task yet")
    }
}
