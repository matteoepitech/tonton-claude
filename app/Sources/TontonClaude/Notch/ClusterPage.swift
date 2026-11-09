import AppKit
import SwiftUI
import TontonCore

// A cluster's page in the notch (#312): its name and clock, the invite for the owner, then its tabs: who is there and
// doing what, the feed, the leaderboard, the claims, the notes, the clock and the members (ClusterTabs.swift,
// ClusterLeaderboardView.swift). Live: every change of the
// cluster draws it again. People read here; only their own sessions post.

enum ClusterTab: String, CaseIterable, Identifiable {
    case roster, feed, leaderboard, claims, notes, clock, members
    var id: String { rawValue }

    var label: String {
        switch self {
        case .roster: String(localized: "Roster")
        case .feed: String(localized: "Feed")
        case .leaderboard: String(localized: "Leaderboard")
        case .claims: String(localized: "Claims")
        case .notes: String(localized: "Notes")
        case .clock: String(localized: "Clock")
        case .members: String(localized: "Members")
        }
    }
}

struct ClusterPage: View {
    let board: ClusterBoard
    let account: String
    /// The account's sessions, to change the delivery of those in the cluster.
    let sessions: [SessionSummary]
    /// The account's sessions that can be put in.
    let candidates: [SessionSummary]
    let back: () -> Void
    @ObservedObject private var clusters = ClusterStore.shared
    @State private var tab = ClusterTab.roster

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ClusterPageHeader(board: board, back: back)
            if board.state != nil { ClusterTabBar(tab: $tab) }
            if let problem = board.problem {
                ClusterProblem(text: problem) { clusters.clearProblem(board.id) }.padding(.trailing, 6)
            }
            if board.state != nil {
                ScrollView {
                    ClusterTabContent(board: board, account: account, sessions: sessions, candidates: candidates, tab: tab)
                        .padding(.trailing, 6)
                        .padding(.bottom, 8)
                }
                .scrollIndicators(.never)
            } else {
                Text("Opening the cluster…").font(.notch(11)).foregroundStyle(Theme.tertiary).padding(.top, 6)
                Spacer(minLength: 0)
            }
        }
    }
}

/// Back, the cluster's name, what it is for, its clock and, for the owner, Invite.
struct ClusterPageHeader: View {
    let board: ClusterBoard
    let back: () -> Void
    @State private var inviting = false

    var body: some View {
        HStack(spacing: 8) {
            Button(action: back) {
                Image(systemName: "chevron.left").font(.notch(11, weight: .semibold)).frame(width: 22, height: 26).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.secondary)
            .help("Back to the clusters")
            .accessibilityLabel("Back to the clusters")
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: board.name).font(.notch(13, weight: .bold)).lineLimit(1).accessibilityAddTraits(.isHeader)
                // Its role, then what it is for: the name keeps the room.
                Text(
                    verbatim: [board.isOwner ? String(localized: "Owner") : String(localized: "Member"), board.info?.about].compactMap {
                        $0
                    }
                    .joined(separator: " · ")
                )
                .font(.notch(10)).foregroundStyle(Theme.tertiary).lineLimit(1)
            }
            Spacer(minLength: 4)
            ClusterClockChip(clock: board.clock)
            if board.isOwner && board.state != nil {
                Button {
                    inviting = true
                } label: {
                    Label("Invite", systemImage: "person.badge.plus")
                }
                .buttonStyle(NotchButtonStyle(kind: .primary))
                .help("A link and a QR code for the people you want in")
                .popover(isPresented: $inviting, arrowEdge: .bottom) { ClusterInviteView(clusterId: board.id) }
            }
        }
        .padding(.trailing, 6)
    }
}

/// The tabs, as chips that wrap on a narrow notch.
struct ClusterTabBar: View {
    @Binding var tab: ClusterTab

    var body: some View {
        FlowLayout(spacing: 5) {
            ForEach(ClusterTab.allCases) { item in
                PoolChoice(title: item.label, picked: item == tab) { tab = item }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Cluster sections")
    }
}

struct ClusterTabContent: View {
    let board: ClusterBoard
    let account: String
    let sessions: [SessionSummary]
    let candidates: [SessionSummary]
    let tab: ClusterTab

    var body: some View {
        if let state = board.state {
            switch tab {
            case .roster: ClusterRoster(board: board, state: state, account: account, sessions: sessions, candidates: candidates)
            case .feed: ClusterFeed(state: state, levelUps: board.levelUps)
            case .leaderboard: ClusterLeaderboardView(board: board, account: account)
            case .claims: ClusterClaimsList(state: state, claims: board.claims?.claims ?? [])
            case .notes: ClusterNotesView(notes: board.notes)
            case .clock: ClusterClockView(board: board)
            case .members: ClusterMembersView(board: board, state: state, account: account)
            }
        }
    }
}

// MARK: Roster

/// Every member, its machines and their sessions, busy ones first, then the account's own sessions to put in.
struct ClusterRoster: View {
    let board: ClusterBoard
    let state: ClusterState
    let account: String
    let sessions: [SessionSummary]
    let candidates: [SessionSummary]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(ClusterModel.roster(state, account: account)) { member in
                memberCard(member)
            }
            ClusterPutIn(board: board, sessions: ClusterModel.outside(candidates, of: state, account: account))
        }
    }

    private func memberCard(_ member: ClusterModel.Member) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(verbatim: member.name).font(.notch(12, weight: .bold)).lineLimit(1)
                if member.mine { PoolChip(text: String(localized: "You")) }
                if member.role == .owner { PoolChip(text: String(localized: "Owner"), tint: Theme.textDim) }
                Spacer(minLength: 4)
                PoolChip(text: "\(member.sessions)", systemImage: "terminal", tint: Theme.textDim)
                    .accessibilityLabel(Text("Sessions: \(member.sessions)"))
            }
            if member.machines.isEmpty {
                Text("No session in the cluster yet.").font(.notch(10.5)).foregroundStyle(Theme.tertiary)
            }
            ForEach(member.machines) { machine in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Image(systemName: "desktopcomputer").font(.notch(9)).accessibilityHidden(true)
                        Text(verbatim: machine.name).font(.notch(10, weight: .semibold)).lineLimit(1)
                    }
                    .foregroundStyle(Theme.tertiary)
                    ForEach(machine.sessions) { session in
                        ClusterSessionRow(
                            board: board, session: session, own: member.mine ? sessions.first { $0.id == session.session } : nil,
                            mine: member.mine)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .poolCard(padding: 9)
    }
}

/// A session of the cluster: its state, what it says it does, and its project, branch, tool and model.
struct ClusterSessionRow: View {
    let board: ClusterBoard
    let session: ClusterState.Session
    /// This account's session, when it is one: its delivery can change.
    let own: SessionSummary?
    let mine: Bool

    @ObservedObject private var clusters = ClusterStore.shared

    var body: some View {
        let profile = session.profile
        VStack(alignment: .leading, spacing: 4) {
            summary(profile)
            if let own, let reason = clusters.choice(for: session.session, in: board.id).digestReason(profile) {
                ClusterTurnedDigest(board: board, session: own, reason: reason).padding(.leading, 14)
            }
        }
        .padding(.vertical, 2)
    }

    private func summary(_ profile: ClusterSessionProfile?) -> some View {
        let status = ClusterModel.status(of: session)
        return HStack(alignment: .top, spacing: 6) {
            HStack(alignment: .top, spacing: 7) {
                Circle().fill(Color(nsColor: status.color)).frame(width: 7, height: 7).padding(.top, 4)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Text(verbatim: ClusterModel.sessionName(session)).font(.notch(11.5, weight: .semibold)).lineLimit(1)
                        Text(verbatim: ClusterModel.state(of: session, mine: mine)).font(.notch(10)).foregroundStyle(
                            Color(nsColor: status.color)
                        )
                        .lineLimit(1).fixedSize()
                    }
                    if let line = profile?.status, !line.isEmpty {
                        Text(verbatim: line + (profile?.statusAt.flatMap(ClusterModel.date).map { " · " + Self.ago($0) } ?? ""))
                            .font(.notch(11)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                    let facts = ClusterModel.facts(profile)
                    if !facts.isEmpty { Text(verbatim: facts).font(.notch(10)).foregroundStyle(Theme.tertiary).lineLimit(1) }
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 4)
            if mine { ClusterOwnMenu(board: board, sessionId: session.session, own: own, profile: profile) }
        }
    }

    static func ago(_ date: Date) -> String { date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)) }
}

/// For one of the account's own sessions in the cluster: how it takes the posts, and the way out, in plain sight.
struct ClusterOwnMenu: View {
    let board: ClusterBoard
    let sessionId: String
    let own: SessionSummary?
    /// What its agent says of it, with how it really takes the posts. Nil before its agent said anything.
    var profile: ClusterSessionProfile?
    @ObservedObject private var clusters = ClusterStore.shared

    var body: some View {
        let choice = clusters.choice(for: sessionId, in: board.id)
        HStack(spacing: 5) {
            if let own {
                ClusterDeliveryMenu(choice: choice, profile: profile) { next in if next != choice { send(next, own) } }
                    .help("How it takes the posts")
            }
            Button {
                clusters.takeOut(sessionId, of: board.id)
            } label: {
                Label("Take out", systemImage: "rectangle.portrait.and.arrow.right")
            }
            .buttonStyle(NotchButtonStyle(kind: .destructive))
            .help("It leaves the cluster and stops reading its posts")
        }
        .fixedSize()
    }

    private func send(_ choice: ClusterSessionChoice, _ session: SessionSummary) {
        do {
            try clusters.put(session, in: board.id, choice: choice)
        } catch {
            clusters.report(error, in: board.id)
        }
    }
}

/// Live, digest or muted, each with what it does, and Live anyway for a session that skips permission prompts. Live
/// that its agent says turned into digests reads so, and the menu says why.
struct ClusterDeliveryMenu: View {
    let choice: ClusterSessionChoice
    /// What the session's agent says of it. Nil for a session not in the cluster yet, or an older agent.
    var profile: ClusterSessionProfile?
    let pick: (ClusterSessionChoice) -> Void

    var body: some View {
        let reason = choice.digestReason(profile)
        NotchMenu(width: 250) {
            let anyway = ClusterSessionChoice(delivery: .live, liveWithoutPrompts: true)
            return [
                NotchMenuSection(
                    title: String(localized: "How it takes the posts"),
                    items: ClusterDelivery.allCases.map { delivery in
                        let option = ClusterSessionChoice(delivery: delivery)
                        return NotchMenuItem(title: delivery.label, detail: delivery.detail, checked: option == choice) { pick(option) }
                    } + [
                        NotchMenuItem(
                            title: String(localized: "Live anyway, if it skips permission prompts"),
                            detail: reason == .prompts ? ClusterSessionChoice.anywayDetail : nil, checked: anyway == choice
                        ) {
                            pick(anyway)
                        }
                    ],
                    note: reason?.text ?? ClusterSessionChoice.promptsNote)
            ]
        } label: {
            NotchMenuLabel(text: reason != nil ? String(localized: "Live → digest") : choice.label)
        }
        .foregroundStyle(Theme.text)
        .accessibilityLabel("Delivery: \(choice.label(for: profile))")
    }
}

/// Under one of the account's sessions set to live that gets digests: why, and Live anyway one click away when it skips
/// permission prompts. A plain codex needs `tonton codex` instead, which no button here can do.
struct ClusterTurnedDigest: View {
    let board: ClusterBoard
    let session: SessionSummary
    let reason: ClusterDigestReason
    @ObservedObject private var clusters = ClusterStore.shared

    var body: some View {
        HStack(spacing: 6) {
            Label {
                Text(verbatim: reason.text).font(.notch(10, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").font(.notch(9))
            }
            .labelStyle(TightLabelStyle())
            .foregroundStyle(Theme.warning)
            Spacer(minLength: 4)
            if reason == .prompts {
                Button("Live anyway") {
                    do {
                        try clusters.put(session, in: board.id, choice: ClusterSessionChoice(delivery: .live, liveWithoutPrompts: true))
                    } catch {
                        clusters.report(error, in: board.id)
                    }
                }
                .buttonStyle(NotchButtonStyle())
                .help(ClusterSessionChoice.anywayDetail)
            }
        }
    }
}

/// The account's running sessions outside the cluster: only their owner puts them in, each with its delivery.
struct ClusterPutIn: View {
    let board: ClusterBoard
    let sessions: [SessionSummary]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Put your sessions in").font(.notch(12, weight: .bold)).accessibilityAddTraits(.isHeader)
            Text(
                "A session in the cluster tells the others what it does and reads what they post, as information, never as orders. Permission prompts stay yours."
            )
            .font(.notch(10.5)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            if sessions.isEmpty {
                Text("None of your running sessions is outside the cluster.").font(.notch(10.5)).foregroundStyle(Theme.tertiary)
            } else {
                ForEach(sessions) { session in ClusterPutInRow(board: board, session: session) }
                Text(ClusterSessionChoice.promptsNote)
                    .font(.notch(9.5)).foregroundStyle(Theme.tertiary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .poolCard(padding: 9)
    }
}

struct ClusterPutInRow: View {
    let board: ClusterBoard
    let session: SessionSummary
    @ObservedObject private var clusters = ClusterStore.shared

    var body: some View {
        let choice = clusters.choice(for: session.id, in: board.id)
        HStack(spacing: 7) {
            HStack(spacing: 7) {
                Circle().fill(Color(nsColor: session.status.color)).frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: session.displayName).font(.notch(11.5, weight: .semibold)).lineLimit(1)
                    Text(verbatim: [session.machine, session.project, session.branch].compactMap { $0 }.joined(separator: " · "))
                        .font(.notch(10)).foregroundStyle(Theme.tertiary).lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 4)
            ClusterDeliveryMenu(choice: choice) { clusters.setChoice($0, for: session.id, in: board.id) }
                .help("How it takes the posts once in")
            Button("Put in") {
                do {
                    try clusters.put(session, in: board.id, choice: choice)
                } catch {
                    clusters.report(error, in: board.id)
                }
            }
            .buttonStyle(NotchButtonStyle(kind: .primary))
            .help("Its agent takes the order, sealed with your account key. Permission prompts stay yours.")
        }
    }
}

// MARK: Feed

/// What the sessions posted, newest first: messages, questions and answers, events, claims, files and notices.
struct ClusterFeed: View {
    let state: ClusterState
    /// The members' level-ups, from the leaderboard: apps never post them.
    var levelUps: [ClusterLevelUpLine] = []
    @State private var kind: ClusterPostKind?
    /// The feed shows this many posts at most: the relay keeps 5000, the app the latest 500.
    private static let shown = 150

    var body: some View {
        let posts = ClusterModel.feed(state, kind: kind)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                NotchMenu(width: 180) {
                    [
                        NotchMenuSection(items: [NotchMenuItem(title: String(localized: "Every post"), checked: kind == nil) { kind = nil }]
                        ),
                        NotchMenuSection(
                            items: ClusterPostKind.allCases.map { item in
                                NotchMenuItem(title: ClusterModel.kindLabel(item), checked: kind == item) { kind = item }
                            }),
                    ]
                } label: {
                    NotchMenuLabel(text: kind.map(ClusterModel.kindLabel) ?? String(localized: "Every post"), size: 10.5)
                }
                .foregroundStyle(Theme.text)
                .accessibilityLabel("Which posts")
                Spacer(minLength: 4)
                Text("People read here; their own Claudes post.").font(.notch(9.5)).foregroundStyle(Theme.tertiary).lineLimit(1)
            }
            let lines = ClusterFeedLine.weave(Array(posts.prefix(Self.shown)), kind == nil ? levelUps : [])
            if lines.isEmpty {
                Text("Nothing posted yet.").font(.notch(11)).foregroundStyle(Theme.tertiary).padding(.top, 4)
            }
            ForEach(lines) { line in
                switch line {
                case .post(let post): ClusterPostView(post: post, state: state)
                case .levelUp(let up): levelUp(up)
                }
            }
        }
    }
}

extension ClusterFeed {
    fileprivate func levelUp(_ up: ClusterLevelUpLine) -> some View {
        HStack(spacing: 5) {
            PoolChip(text: String(localized: "Level up"), systemImage: "sparkles", tint: Theme.accent)
            Text("\(ClusterModel.memberName(state, account: up.account))’s Tonton reached level \(up.level)")
                .font(.notch(10.5, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 4)
            if let date = ClusterModel.date(up.at) {
                Text(verbatim: ClusterSessionRow.ago(date)).font(.notch(9.5)).foregroundStyle(Theme.tertiary).lineLimit(1).fixedSize()
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }
}

/// A line of the feed: a post, or a member's level-up woven in by time.
enum ClusterFeedLine: Identifiable {
    case post(ClusterState.Post)
    case levelUp(ClusterLevelUpLine)

    var id: String {
        switch self {
        case .post(let post): post.id
        case .levelUp(let up): "level-\(up.account)-\(up.level)-\(up.at)"
        }
    }

    /// Posts in the relay's order and level-ups by time, both newest first.
    static func weave(_ posts: [ClusterState.Post], _ ups: [ClusterLevelUpLine]) -> [ClusterFeedLine] {
        var lines: [ClusterFeedLine] = []
        var next = ups.startIndex
        let time = { (text: String) in ClusterModel.date(text) ?? .distantPast }
        for post in posts {
            while next < ups.endIndex, time(ups[next].at) > time(post.ts) {
                lines.append(.levelUp(ups[next]))
                next += 1
            }
            lines.append(.post(post))
        }
        return lines + ups[next...].map(ClusterFeedLine.levelUp)
    }
}

struct ClusterPostView: View {
    let post: ClusterState.Post
    let state: ClusterState

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                if let body = post.body {
                    PoolChip(text: ClusterModel.kindLabel(body.kind), systemImage: Self.icon(body.kind), tint: Self.tint(body))
                }
                Text(verbatim: ClusterModel.author(state, account: post.account, session: post.session))
                    .font(.notch(10.5, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 4)
                if let date = ClusterModel.date(post.ts) {
                    Text(verbatim: ClusterSessionRow.ago(date)).font(.notch(9.5)).foregroundStyle(Theme.tertiary).lineLimit(1).fixedSize()
                        .help(date.formatted(date: .abbreviated, time: .standard))
                }
            }
            let to = ClusterModel.recipients(state, post.body).map { String(localized: "to \($0)") }
            let topic = post.body?.topic.map { "#\($0)" }
            if to != nil || topic != nil {
                Text(verbatim: [to, topic].compactMap { $0 }.joined(separator: " · ")).font(.notch(10)).foregroundStyle(Theme.tertiary)
                    .lineLimit(1)
            }
            if let body = post.body {
                if let replied = ClusterModel.replied(post, in: state), let quoted = replied.body {
                    HStack(spacing: 6) {
                        Capsule().fill(Theme.borderStrong).frame(width: 2)
                        Text(verbatim: "\(ClusterModel.memberName(state, account: replied.account)): \(quoted.text)")
                            .font(.notch(10)).foregroundStyle(Theme.tertiary).lineLimit(1)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                if !body.text.isEmpty {
                    Text(verbatim: body.text).font(.notch(11.5)).lineLimit(10).fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                if let event = ClusterModel.eventLine(body.event) {
                    Text(verbatim: event).font(.notch(10, design: .monospaced))
                        .foregroundStyle(body.event?.ok == false ? Theme.danger : Theme.text).lineLimit(1)
                }
                if let paths = body.event?.paths, !paths.isEmpty {
                    Text(verbatim: paths.joined(separator: ", ")).font(.notch(9.5, design: .monospaced)).foregroundStyle(Theme.tertiary)
                        .lineLimit(2)
                }
                if let file = ClusterModel.fileLine(body.file) {
                    Label(file, systemImage: "doc").labelStyle(TightLabelStyle()).font(.notch(10)).foregroundStyle(Theme.secondary)
                        .lineLimit(1)
                }
            } else {
                Text("This post does not open with the keys you hold.").font(.notch(10.5)).foregroundStyle(Theme.tertiary)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.raised))
        .accessibilityElement(children: .combine)
    }

    static func icon(_ kind: ClusterPostKind) -> String {
        switch kind {
        case .message: "bubble.left.fill"
        case .ask: "questionmark.bubble.fill"
        case .answer: "arrowshape.turn.up.left.fill"
        case .event: "bolt.fill"
        case .claim: "lock.fill"
        case .file: "doc.fill"
        case .notice: "bell.fill"
        }
    }

    static func tint(_ body: ClusterPostBody) -> Color {
        switch body.kind {
        case .ask: Theme.warning
        case .answer: Theme.success
        case .event: body.event?.ok == false ? Theme.danger : Theme.accent
        case .claim, .file: Theme.textDim
        case .message, .notice: Theme.accent
        }
    }
}
