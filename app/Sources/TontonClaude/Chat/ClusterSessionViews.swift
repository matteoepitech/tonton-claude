import SwiftUI
import TontonCore

// A session and its clusters, from the chat header (#312): put it in a cluster or take it out, and choose how it takes
// the posts: live, digest or muted (docs/cluster.md, The rule). Only its owner does this; the order is sealed with the
// account key for the session's own agent.

/// In the chat header: the session's clusters, or a way to put it in one. Shown once the account is in a cluster.
struct ClusterButton: View {
    let session: SessionSummary
    @ObservedObject private var clusters = ClusterStore.shared
    @EnvironmentObject var state: NotchState

    var body: some View {
        let memberships = clusters.memberships(of: session.id)
        if !clusters.boards.isEmpty || !memberships.isEmpty {
            let open = Binding(get: { state.clusterOf == session.id }, set: { state.clusterOf = $0 ? session.id : nil })
            Button {
                state.clusterOf = state.clusterOf == session.id ? nil : session.id
            } label: {
                Image(
                    systemName: memberships.isEmpty
                        ? "point.3.connected.trianglepath.dotted" : "point.3.filled.connected.trianglepath.dotted"
                )
                .font(.notch(11))
            }
            .buttonStyle(.plain)
            .foregroundStyle(memberships.isEmpty ? Theme.secondary : AnyShapeStyle(Theme.accent))
            .help(
                memberships.isEmpty
                    ? String(localized: "Put this session in a cluster")
                    : String(localized: "In \(memberships.map(\.board.name).joined(separator: ", "))")
            )
            .accessibilityLabel(
                memberships.isEmpty ? String(localized: "Put in a cluster") : String(localized: "Clusters of this session")
            )
            .popover(isPresented: open, arrowEdge: .bottom) { ClusterSessionPanel(session: session) }
        }
    }
}

/// The popover: the clusters the session is in, each with its delivery and Take out, then a way to put it in another.
struct ClusterSessionPanel: View {
    let session: SessionSummary
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var notch: NotchState
    @ObservedObject private var clusters = ClusterStore.shared

    var body: some View {
        ClusterSessionContent(
            session: session, memberships: clusters.memberships(of: session.id), joinable: clusters.joinable(for: session.id),
            why: store.whyNotCluster(session), noCluster: clusters.boards.isEmpty,
            open: { clusterId in
                clusters.opened = clusterId
                notch.clusterOf = nil
                notch.showHero = false
                notch.showClusters = true
            }
        )
        .padding(14)
        .frame(width: 340)
        .task { await clusters.refresh() }
    }
}

struct ClusterSessionContent: View {
    let session: SessionSummary
    let memberships: [(board: ClusterBoard, session: ClusterState.Session)]
    let joinable: [ClusterBoard]
    /// Why it cannot be put in, when it cannot.
    let why: String?
    let noCluster: Bool
    let open: (String) -> Void
    @ObservedObject private var clusters = ClusterStore.shared
    @State private var target: String?
    @State private var choice = ClusterSessionChoice.standard
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                IconTile(systemName: "point.3.connected.trianglepath.dotted", tint: Theme.accent, size: 30).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(memberships.isEmpty ? "Put this session in a cluster" : "This session's clusters")
                        .font(.notch(13, weight: .bold)).accessibilityAddTraits(.isHeader)
                    Text(
                        verbatim: [session.displayName, session.codingTool.label, session.modelName].compactMap { $0 }.joined(
                            separator: " · ")
                    )
                    .font(.notch(10.5)).foregroundStyle(Theme.tertiary).lineLimit(1)
                }
            }
            ForEach(memberships, id: \.board.id) { membership in
                inCluster(membership.board, membership.session)
            }
            if let why {
                Text(verbatim: why).font(.notch(11)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            } else if noCluster {
                Text("This account is in no cluster yet. Make one or join one with the clusters button at the bottom of the notch.")
                    .font(.notch(11)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            } else if !joinable.isEmpty {
                putIn
            }
            if why == nil && (!memberships.isEmpty || !joinable.isEmpty) {
                Text(ClusterSessionChoice.promptsNote).font(.notch(9.5)).foregroundStyle(Theme.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error {
                Text(verbatim: error).font(.notch(10)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// A cluster the session is in: whether its agent took the order, how it takes the posts, and the way out.
    private func inCluster(_ board: ClusterBoard, _ member: ClusterState.Session) -> some View {
        let current = clusters.choice(for: session.id, in: board.id)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(verbatim: board.name).font(.notch(12, weight: .bold)).lineLimit(1)
                Spacer(minLength: 4)
                HStack(spacing: 4) {
                    Circle().fill(member.ready ? Theme.success : Theme.warning).frame(width: 6, height: 6)
                    Text(member.ready ? "In the cluster" : "Waiting for its agent").font(.notch(10)).foregroundStyle(Theme.tertiary)
                }
                .accessibilityElement(children: .combine)
                Button("Open") { open(board.id) }.buttonStyle(NotchButtonStyle()).help("The cluster's roster, feed, claims and clock")
            }
            deliveryPicker(current) { next in send(next, to: board.id) }
            HStack {
                Spacer()
                Button("Take out", role: .destructive) { clusters.takeOut(session.id, of: board.id) }
                    .buttonStyle(NotchButtonStyle(kind: .destructive))
                    .help("It leaves the cluster and stops reading its posts")
            }
        }
        .poolCard(padding: 9)
    }

    private var putIn: some View {
        let selected = joinable.first { $0.id == target } ?? joinable[0]
        return VStack(alignment: .leading, spacing: 8) {
            if joinable.count > 1 || !memberships.isEmpty {
                section(memberships.isEmpty ? "Cluster" : "Put it in another cluster too") {
                    FlowLayout {
                        ForEach(joinable, id: \.id) { board in
                            PoolChoice(title: board.name, picked: board.id == selected.id) { target = board.id }
                        }
                    }
                }
            }
            deliveryPicker(choice) { choice = $0 }
            HStack {
                if let left = ClusterModel.clock(selected.clock).label { PoolChip(text: left, systemImage: "timer") }
                Spacer()
                Button {
                    send(choice, to: selected.id)
                } label: {
                    Label(String(localized: "Put in \(selected.name)"), systemImage: "arrow.right")
                }
                .buttonStyle(NotchButtonStyle(kind: .primary))
                .keyboardShortcut(.defaultAction)
                .help("Its agent takes the order, sealed with your account key. Permission prompts stay yours.")
            }
        }
        .onAppear { choice = clusters.choice(for: session.id, in: selected.id) }
    }

    /// Live, digest or muted, what each does, and Live anyway for a session that skips permission prompts.
    private func deliveryPicker(_ current: ClusterSessionChoice, pick: @escaping (ClusterSessionChoice) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                ForEach(ClusterDelivery.allCases, id: \.self) { delivery in
                    PoolChoice(title: delivery.label, picked: current.delivery == delivery) {
                        pick(ClusterSessionChoice(delivery: delivery, liveWithoutPrompts: current.liveWithoutPrompts))
                    }
                    .help(delivery.detail)
                }
            }
            Text(verbatim: current.delivery.detail).font(.notch(10)).foregroundStyle(Theme.tertiary)
            if current.delivery == .live {
                Toggle(
                    isOn: Binding(
                        get: { current.liveWithoutPrompts }, set: { pick(ClusterSessionChoice(delivery: .live, liveWithoutPrompts: $0)) })
                ) {
                    Text("Live anyway, if it skips permission prompts").font(.notch(11))
                }
                .toggleStyle(AccentToggleStyle())
            }
        }
    }

    private func send(_ next: ClusterSessionChoice, to clusterId: String) {
        do {
            try clusters.put(session, in: clusterId, choice: next)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func section<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.notch(10, weight: .semibold)).foregroundStyle(Theme.tertiary)
            content()
        }
    }
}
