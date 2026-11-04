import AppKit
import SwiftUI
import TontonCore

// The clusters in the open notch (#312, docs/cluster.md): in the right column instead of the chat, from the bottom bar's
// button. The account's clusters, making one and joining one with a pasted invite, then a cluster's own page
// (ClusterPage.swift). In the pools' style (Chat/PoolDesign.swift); the logic is in TontonCore (ClusterModel, ClusterBoard).

/// What the right column shows while the clusters are open.
struct ClustersPanel: View {
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var notch: NotchState
    @ObservedObject private var clusters = ClusterStore.shared

    var body: some View {
        Group {
            if let id = clusters.opened, let board = clusters.boards[id] {
                ClusterPage(
                    board: board, account: clusters.accountId ?? "", sessions: store.sessions, candidates: store.clusterCandidates,
                    back: { clusters.opened = nil })
            } else {
                ClusterList(
                    boards: clusters.ordered, problem: clusters.problem, supported: clusters.supported,
                    connected: store.connection == .connected, close: { notch.showClusters = false })
            }
        }
        .padding(.leading, 10)
        .padding(.top, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task { await clusters.refresh() }
        // Picking another session brings its conversation back; the store moving the selection by itself does not.
        .onChange(of: store.selectedId) { old, _ in
            if let old, store.visibleSessions.contains(where: { $0.id == old }) { notch.showClusters = false }
        }
    }
}

/// In the open notch's bottom bar: the clusters, in the right column instead of the chat.
struct ClustersButton: View {
    @EnvironmentObject var state: NotchState

    var body: some View {
        let shown = state.showClusters && !state.showHero
        Button {
            state.showClusters = !shown
            if !shown { state.showHero = false }
        } label: {
            Image(systemName: shown ? "point.3.filled.connected.trianglepath.dotted" : "point.3.connected.trianglepath.dotted")
                .font(.notch(12))
        }
        .buttonStyle(.plain)
        .foregroundStyle(shown ? Theme.accent : Theme.ink.opacity(0.7))
        .help("Clusters: the sessions of several people, telling each other what they do")
        .accessibilityLabel("Clusters")
        .accessibilityAddTraits(shown ? .isSelected : [])
    }
}

/// The account's clusters as cards, with New and Join.
struct ClusterList: View {
    let boards: [ClusterBoard]
    let problem: String?
    let supported: Bool
    let connected: Bool
    let close: () -> Void
    @ObservedObject private var clusters = ClusterStore.shared
    @State private var form: Form?

    enum Form { case create, join }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            ScrollView {
                ClusterListContent(boards: boards, problem: problem, supported: supported, connected: connected, form: $form)
                    .padding(.trailing, 6)
                    .padding(.bottom, 8)
            }
            .scrollIndicators(.never)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            IconTile(systemName: "point.3.connected.trianglepath.dotted", tint: Theme.accent, size: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text("Clusters").font(.notch(13, weight: .bold)).accessibilityAddTraits(.isHeader)
                Text("Your team's sessions, together")
                    .font(.notch(10)).foregroundStyle(Theme.tertiary).lineLimit(1)
            }
            Spacer(minLength: 6)
            Button("Join") { form = form == .join ? nil : .join }
                .buttonStyle(NotchButtonStyle())
                .disabled(!connected || !supported)
                .help("Join a cluster with the invite someone sent you")
            Button {
                form = form == .create ? nil : .create
            } label: {
                Label("New", systemImage: "plus")
            }
            .buttonStyle(NotchButtonStyle(kind: .primary))
            .disabled(!connected || !supported)
            .help("Make a cluster: its key is made on this Mac")
            Button(action: close) { Image(systemName: "xmark").font(.notch(10, weight: .semibold)) }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.secondary)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
                .help("Back to the conversation")
                .accessibilityLabel("Close the clusters")
        }
        .padding(.trailing, 6)
    }
}

/// What is under the list's header: what the relay says, the form open, and a card per cluster.
struct ClusterListContent: View {
    let boards: [ClusterBoard]
    let problem: String?
    let supported: Bool
    let connected: Bool
    @Binding var form: ClusterList.Form?
    @ObservedObject private var clusters = ClusterStore.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !supported {
                ClusterNotice(text: Cluster.unsupported, systemImage: "exclamationmark.arrow.triangle.2.circlepath")
            } else if !connected {
                ClusterNotice(text: String(localized: "Connect to the relay to use clusters."), systemImage: "wifi.slash")
            }
            if let problem, supported {
                ClusterProblem(text: problem) { clusters.clearProblem() }
            }
            switch form {
            case .create: ClusterCreateForm { form = nil }
            case .join: ClusterJoinForm { form = nil }
            case nil: EmptyView()
            }
            if boards.isEmpty && form == nil && supported {
                Text("No cluster yet. Make one for a jam or a sprint, or join one with the invite someone sent you.")
                    .font(.notch(11)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
            }
            ForEach(boards, id: \.id) { board in
                ClusterCard(board: board) { clusters.opened = board.id }
            }
        }
    }
}

/// One cluster in the list: its name and clock, who is working, and the last post.
struct ClusterCard: View {
    let board: ClusterBoard
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(verbatim: board.name).font(.notch(12, weight: .bold)).lineLimit(1)
                    if board.isOwner { PoolChip(text: String(localized: "Owner"), tint: Theme.textDim) }
                    Spacer(minLength: 4)
                    ClusterClockChip(clock: board.clock)
                    Image(systemName: "chevron.right").font(.notch(9, weight: .semibold)).foregroundStyle(Theme.tertiary)
                        .accessibilityHidden(true)
                }
                if let about = board.info?.about {
                    Text(verbatim: about).font(.notch(10.5)).foregroundStyle(Theme.secondary).lineLimit(2)
                }
                if let state = board.state {
                    let busy = state.sessions.filter { $0.online && ["working", "permission", "waiting"].contains($0.status ?? "") }.count
                    HStack(spacing: 6) {
                        PoolChip(text: String(localized: "\(busy) of \(state.sessions.count) working"), systemImage: "bolt.fill")
                        PoolChip(text: "\(state.members.count)", systemImage: "person.2.fill", tint: Theme.textDim)
                            .accessibilityLabel(Text("Members: \(state.members.count)"))
                    }
                    // The last post that opens, in a line.
                    if let last = state.posts.last(where: { $0.body != nil }), let body = last.body {
                        let author = ClusterModel.memberName(state, account: last.account)
                        let line = body.text.isEmpty ? ClusterModel.eventLine(body.event) ?? "" : body.text
                        Text(verbatim: "\(author): \(line)").font(.notch(10.5)).foregroundStyle(Theme.tertiary).lineLimit(1)
                    }
                } else {
                    Text("Opening the cluster…").font(.notch(10.5)).foregroundStyle(Theme.tertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .poolCard(padding: 9)
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("Opens the cluster"))
    }
}

/// The time left on a cluster's clock, red in its last hour. Redrawn every 30 seconds.
struct ClusterClockChip: View {
    let clock: ClusterClock?

    var body: some View {
        if clock?.deadline != nil {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let view = ClusterModel.clock(clock, now: context.date)
                if let label = view.label {
                    PoolChip(text: label, systemImage: "timer", tint: view.lastHour || view.ended ? Theme.danger : Theme.accent)
                        .help(
                            view.deadline.map { String(localized: "Deadline: \($0.formatted(date: .abbreviated, time: .shortened))") } ?? ""
                        )
                }
            }
        }
    }
}

/// Makes a cluster: what it is for, and the name the others see.
struct ClusterCreateForm: View {
    let done: () -> Void
    @ObservedObject private var clusters = ClusterStore.shared
    @State private var name = ""
    @State private var about = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("New cluster").font(.notch(12, weight: .bold)).accessibilityAddTraits(.isHeader)
            Text(
                "The Claude Code and OpenCode sessions of several people tell each other what they do, ask, and hold files. Nobody drives anyone else's Claude."
            )
            .font(.notch(10.5)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            ClusterField(placeholder: "Name, such as Game jam", text: $name).onSubmit(create)
            ClusterField(placeholder: "What it is for, optional", text: $about).onSubmit(create)
            ClusterField(placeholder: "Your name, as the others see it", text: $clusters.memberName).onSubmit(create)
            HStack(spacing: 6) {
                Text("Its key is made on this Mac: the relay never reads the cluster.")
                    .font(.notch(9.5)).foregroundStyle(Theme.tertiary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button("Cancel", action: done).buttonStyle(NotchButtonStyle())
                Button("Create", action: create)
                    .buttonStyle(NotchButtonStyle(kind: .primary))
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .poolCard(highlighted: true, padding: 10)
    }

    private func create() {
        guard !busy, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        busy = true
        Task {
            let id = await clusters.create(name: name, about: about)
            busy = false
            if let id {
                done()
                clusters.opened = id
            }
        }
    }
}

/// Joins a cluster with the invite someone sent: a link to the website or the invite alone.
struct ClusterJoinForm: View {
    let done: () -> Void
    @ObservedObject private var clusters = ClusterStore.shared
    @State private var text = ""
    @State private var busy = false

    var body: some View {
        let invite = ClusterInvite(string: text)
        VStack(alignment: .leading, spacing: 7) {
            Text("Join a cluster").font(.notch(12, weight: .bold)).accessibilityAddTraits(.isHeader)
            Text("Paste the link someone sent you. Then put your sessions in, one by one, from the cluster's roster.")
                .font(.notch(10.5)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                ClusterField(placeholder: "The invite link", text: $text).onSubmit(join)
                Button("Paste") { text = NSPasteboard.general.string(forType: .string) ?? text }
                    .buttonStyle(NotchButtonStyle())
                    .help("Paste the invite from the clipboard")
            }
            if let invite {
                Text("Invite to a cluster on \(URL(string: invite.relay)?.host ?? invite.relay)")
                    .font(.notch(10)).foregroundStyle(Theme.tertiary).lineLimit(1)
            }
            ClusterField(placeholder: "Your name, as the others see it", text: $clusters.memberName).onSubmit(join)
            HStack(spacing: 6) {
                Text("The invite holds the cluster key: it stays on this Mac.")
                    .font(.notch(9.5)).foregroundStyle(Theme.tertiary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button("Cancel", action: done).buttonStyle(NotchButtonStyle())
                Button("Join", action: join)
                    .buttonStyle(NotchButtonStyle(kind: .primary))
                    .disabled(busy || invite == nil)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .poolCard(highlighted: true, padding: 10)
    }

    private func join() {
        guard !busy, ClusterInvite(string: text) != nil else { return }
        busy = true
        Task {
            let id = await clusters.join(text)
            busy = false
            if let id {
                text = ""
                done()
                clusters.opened = id
            }
        }
    }
}

/// A text field in the notch's size, for the cluster forms.
struct ClusterField: View {
    let placeholder: LocalizedStringKey
    @Binding var text: String
    @FocusState private var focused: Bool

    var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.textFaint))
            .textFieldStyle(.plain)
            .font(.notch(11))
            .focused($focused)
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.ink.opacity(0.07)))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(focused ? Theme.accent.opacity(0.7) : Theme.border))
            .accessibilityLabel(Text(placeholder))
    }
}

/// Something the relay or the notch says about the clusters, not an error.
struct ClusterNotice: View {
    let text: String
    let systemImage: String

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: systemImage).font(.notch(11)).foregroundStyle(Theme.warning).accessibilityHidden(true)
            Text(verbatim: text).font(.notch(11)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .poolCard(padding: 9)
    }
}

/// What the relay refused, until dismissed.
struct ClusterProblem: View {
    let text: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: "exclamationmark.triangle.fill").font(.notch(10.5)).foregroundStyle(Theme.danger).accessibilityHidden(true)
            Text(verbatim: text).font(.notch(11)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button(action: dismiss) { Image(systemName: "xmark").font(.notch(9, weight: .semibold)) }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.secondary)
                .accessibilityLabel("Dismiss")
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.danger.opacity(0.1)))
    }
}
