import AppKit
import SwiftUI
import TontonCore

// The other tabs of a cluster's page (ClusterPage.swift): the claims and the notes the sessions keep, the clock every
// member sees and its owner sets, the members with the invites, and the invite itself with its QR code.

// MARK: Claims and notes

/// Who holds which file, folder or asset, and why. Sessions write them; people read them here.
struct ClusterClaimsList: View {
    let state: ClusterState
    let claims: [ClusterClaim]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let held = ClusterModel.heldClaims(claims, now: context.date)
            VStack(alignment: .leading, spacing: 6) {
                if held.isEmpty {
                    Text("No claims: nobody holds a file right now.").font(.notch(11)).foregroundStyle(Theme.tertiary).padding(.top, 4)
                }
                ForEach(held) { claim in row(claim) }
            }
        }
    }

    private func row(_ claim: ClusterClaim) -> some View {
        let session = state.sessions.first { $0.account == claim.account && $0.session == claim.session }
        let who = [ClusterModel.memberName(state, account: claim.account), session.map(ClusterModel.sessionName)].compactMap { $0 }
        let since = ClusterModel.date(claim.at).map(ClusterSessionRow.ago)
        let until = claim.until.flatMap(ClusterModel.date).map {
            String(localized: "until \($0.formatted(date: .omitted, time: .shortened))")
        }
        return HStack(alignment: .top, spacing: 7) {
            Image(systemName: "lock.fill").font(.notch(10)).foregroundStyle(Theme.tertiary).padding(.top, 2).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: claim.paths.joined(separator: ", ")).font(.notch(10.5, design: .monospaced)).lineLimit(2)
                Text(verbatim: (who + [since, until].compactMap { $0 }).joined(separator: " · ")).font(.notch(10))
                    .foregroundStyle(Theme.tertiary).lineLimit(1)
                if let reason = claim.reason, !reason.isEmpty { Text(verbatim: reason).font(.notch(11)).lineLimit(3) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.raised))
        .accessibilityElement(children: .combine)
    }
}

/// The shared board: conventions, interfaces, decisions.
struct ClusterNotesView: View {
    let notes: ClusterNotes?

    var body: some View {
        let text = notes?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.isEmpty {
            Text("No notes yet. The sessions write conventions, interfaces and decisions here.")
                .font(.notch(11)).foregroundStyle(Theme.tertiary).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
        } else {
            MarkdownText(text: text).frame(maxWidth: .infinity, alignment: .leading).poolCard(padding: 10)
        }
    }
}

// MARK: Clock

/// The time left and the milestones, the same for every member; the owner sets them below.
struct ClusterClockView: View {
    let board: ClusterBoard

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let clock = ClusterModel.clock(board.clock, now: context.date)
                VStack(alignment: .leading, spacing: 8) {
                    if let label = clock.label {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: label).font(.notch(22, weight: .bold))
                                .foregroundStyle(clock.ended || clock.lastHour ? Theme.danger : Theme.text)
                            if let deadline = clock.deadline {
                                Text("Deadline: \(deadline.formatted(date: .abbreviated, time: .shortened))")
                                    .font(.notch(10.5)).foregroundStyle(Theme.secondary)
                            }
                            if let next = clock.next {
                                Text("Next: \(next.name), \(next.at.formatted(date: .abbreviated, time: .shortened))").font(.notch(10.5))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .poolCard(highlighted: clock.lastHour, padding: 10)
                        .accessibilityElement(children: .combine)
                    } else {
                        Text(board.isOwner ? "No clock yet. Set a deadline below." : "No clock yet. The owner can set one.")
                            .font(.notch(11)).foregroundStyle(Theme.tertiary).padding(.top, 4)
                    }
                    if !clock.marks.isEmpty {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(clock.marks) { mark in
                                HStack(spacing: 7) {
                                    Image(systemName: mark.passed ? "checkmark.circle.fill" : "circle").font(.notch(10.5))
                                        .foregroundStyle(mark.passed ? AnyShapeStyle(Theme.success) : Theme.tertiary)
                                        .accessibilityLabel(mark.passed ? Text("Passed") : Text("Ahead"))
                                    Text(verbatim: mark.name).font(.notch(11)).strikethrough(mark.passed).lineLimit(1)
                                        .foregroundStyle(mark.passed ? Theme.tertiary : AnyShapeStyle(Theme.text))
                                    Spacer(minLength: 4)
                                    Text(verbatim: mark.at.formatted(date: .abbreviated, time: .shortened)).font(.notch(10))
                                        .foregroundStyle(Theme.tertiary).fixedSize()
                                }
                            }
                        }
                        .poolCard(padding: 9)
                    }
                }
            }
            if board.isOwner {
                // Drawn again from what was saved when someone else changed the clock meanwhile.
                ClusterClockForm(board: board).id(board.clockRev)
            }
        }
    }
}

/// The owner edits the deadline and the milestones; saving writes over the revision this member saw.
struct ClusterClockForm: View {
    let board: ClusterBoard
    @ObservedObject private var clusters = ClusterStore.shared
    @State private var draft: ClusterClockDraft
    @State private var saved = false

    init(board: ClusterBoard) {
        self.board = board
        _draft = State(initialValue: ClusterClockDraft(board.clock))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Set the clock").font(.notch(12, weight: .bold)).accessibilityAddTraits(.isHeader)
            Toggle(isOn: $draft.hasDeadline) { Text("A deadline for everyone").font(.notch(11)) }
                .toggleStyle(AccentToggleStyle())
            if draft.hasDeadline {
                DatePicker("Deadline", selection: $draft.deadline).labelsHidden().datePickerStyle(.field).font(.notch(11))
            }
            if !draft.marks.isEmpty {
                Text("Milestones").font(.notch(10, weight: .semibold)).foregroundStyle(Theme.tertiary)
            }
            ForEach($draft.marks) { $mark in
                HStack(spacing: 6) {
                    ClusterField(placeholder: "Playable build", text: $mark.name)
                    DatePicker("When", selection: $mark.at).labelsHidden().datePickerStyle(.field).font(.notch(11)).fixedSize()
                    Button {
                        draft.marks.removeAll { $0.id == mark.id }
                    } label: {
                        Image(systemName: "xmark").font(.notch(9, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.secondary)
                    .accessibilityLabel("Remove the milestone")
                }
            }
            HStack(spacing: 6) {
                Button {
                    draft = draft.adding()
                } label: {
                    Label("Milestone", systemImage: "plus")
                }
                .buttonStyle(NotchButtonStyle())
                if saved { Text("Sent to every member.").font(.notch(10)).foregroundStyle(Theme.tertiary) }
                Spacer(minLength: 4)
                Button("Save the clock") {
                    saved = clusters.setClock(draft.clock(startedAt: board.clock?.startedAt), in: board.id)
                }
                .buttonStyle(NotchButtonStyle(kind: .primary))
            }
        }
        .poolCard(padding: 10)
    }
}

// MARK: Members

/// Who is in, the name this member shows, the open invites and the way out. Removing a member gives the cluster a new
/// key, wrapped for each member left: the website does that.
struct ClusterMembersView: View {
    let board: ClusterBoard
    let state: ClusterState
    let account: String
    @ObservedObject private var clusters = ClusterStore.shared
    @State private var name: String
    @State private var leaving = false
    @State private var invites: [ClusterInviteSummary] = []

    init(board: ClusterBoard, state: ClusterState, account: String) {
        (self.board, self.state, self.account) = (board, state, account)
        _name = State(initialValue: state.members.first { $0.account == account }?.profile?.name ?? "")
    }

    var body: some View {
        let current = state.members.first { $0.account == account }?.profile?.name ?? ""
        let members = state.members.sorted { ($0.role == .owner ? 0 : 1, $0.joinedAt) < ($1.role == .owner ? 0 : 1, $1.joinedAt) }
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(members) { member in row(member) }
            }
            .poolCard(padding: 9)
            if board.isOwner {
                HStack(alignment: .top, spacing: 7) {
                    Text("To remove a member, use the relay's website: the cluster gets a new key there, which they never receive.")
                        .font(.notch(10.5)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if let url = clusters.websiteURL() {
                        Button {
                            NSWorkspace.shared.open(url)
                        } label: {
                            Label("Website", systemImage: "safari")
                        }
                        .buttonStyle(NotchButtonStyle())
                        .help("Remove members on the relay's website")
                    }
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("Your name in the cluster").font(.notch(10, weight: .semibold)).foregroundStyle(Theme.tertiary)
                HStack(spacing: 6) {
                    ClusterField(placeholder: "How the others see you", text: $name).onSubmit(rename)
                    Button("Save", action: rename)
                        .buttonStyle(NotchButtonStyle())
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || name == current)
                }
            }
            if board.isOwner && !invites.isEmpty { openInvites }
            leave
        }
        .task(id: board.keyring.version) {
            // A rotation revokes every open invite: the list is read again with each key.
            if board.isOwner { invites = await clusters.invites(board.id) }
        }
    }

    private func row(_ member: ClusterState.Member) -> some View {
        let sessions = state.sessions.filter { $0.account == member.account }.count
        let joined = ClusterModel.date(member.joinedAt).map {
            String(localized: "Joined \($0.formatted(date: .abbreviated, time: .omitted))")
        }
        return HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(verbatim: ClusterModel.memberName(state, account: member.account)).font(.notch(11.5, weight: .semibold)).lineLimit(
                        1)
                    if member.account == account { PoolChip(text: String(localized: "You")) }
                    if member.role == .owner { PoolChip(text: String(localized: "Owner"), tint: Theme.textDim) }
                }
                if let joined { Text(verbatim: joined).font(.notch(10)).foregroundStyle(Theme.tertiary) }
            }
            Spacer(minLength: 4)
            PoolChip(text: "\(sessions)", systemImage: "terminal", tint: Theme.textDim).accessibilityLabel(Text("Sessions: \(sessions)"))
        }
        .accessibilityElement(children: .combine)
    }

    private var openInvites: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Open invites").font(.notch(10, weight: .semibold)).foregroundStyle(Theme.tertiary)
            ForEach(invites) { invite in
                HStack(spacing: 6) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Uses left: \(invite.usesLeft)").font(.notch(11))
                        if let until = ClusterModel.date(invite.expiresAt) {
                            Text("Until \(until.formatted(date: .abbreviated, time: .shortened))").font(.notch(10)).foregroundStyle(
                                Theme.tertiary)
                        }
                    }
                    Spacer(minLength: 4)
                    Button("Revoke") {
                        Task {
                            if await clusters.revoke(invite: invite.id, cluster: board.id) { invites = await clusters.invites(board.id) }
                        }
                    }
                    .buttonStyle(NotchButtonStyle(kind: .destructive))
                }
            }
        }
        .poolCard(padding: 9)
    }

    @ViewBuilder private var leave: some View {
        if leaving {
            VStack(alignment: .leading, spacing: 6) {
                Text(
                    board.isOwner
                        ? "Delete the cluster for everyone? Its posts, notes, claims and clock go, and every session leaves it. This cannot be undone."
                        : "Leave the cluster? Your sessions leave it with you. You need a new invite to come back."
                )
                .font(.notch(11)).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Spacer()
                    Button("Cancel") { leaving = false }.buttonStyle(NotchButtonStyle())
                    Button(board.isOwner ? "Delete" : "Leave", role: .destructive) {
                        Task {
                            if await clusters.leave(board.id) { clusters.opened = nil }
                            leaving = false
                        }
                    }
                    .buttonStyle(NotchButtonStyle(kind: .destructive))
                }
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.danger.opacity(0.1)))
        } else {
            Button {
                leaving = true
            } label: {
                Label(
                    board.isOwner ? "Delete the cluster" : "Leave the cluster",
                    systemImage: board.isOwner ? "trash" : "rectangle.portrait.and.arrow.right")
            }
            .buttonStyle(NotchButtonStyle(kind: .destructive))
        }
    }

    private func rename() {
        clusters.rename(name, in: board.id)
    }
}

// MARK: Invite

/// The owner invites in one click: a link for up to 20 people over a week, with its QR code. The link holds the cluster key.
struct ClusterInviteView: View {
    let clusterId: String
    @ObservedObject private var clusters = ClusterStore.shared
    @State private var link: String?
    @State private var failed = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ClusterInviteContent(link: link, failed: failed, copied: copied) {
                guard let link else { return }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(link, forType: .string)
                copied = true
            }
        }
        .padding(14)
        .frame(width: 320)
        .task {
            link = await clusters.invite(clusterId)
            failed = link == nil
        }
    }
}

struct ClusterInviteContent: View {
    let link: String?
    let failed: Bool
    let copied: Bool
    let copy: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                IconTile(systemName: "person.badge.plus", tint: Theme.accent, size: 30).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Invite people").font(.notch(13, weight: .bold)).accessibilityAddTraits(.isHeader)
                    Text("Up to 20 people, for a week").font(.notch(10.5)).foregroundStyle(Theme.tertiary)
                }
            }
            Text("Send them this link, or let them scan the code. It holds the cluster key: send it to people you trust.")
                .font(.notch(11)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            if let link {
                if let code = QRCode(link) {
                    QRCodeView(code: code, module: 3, label: "QR code of the cluster invite").frame(maxWidth: .infinity)
                }
                Text(verbatim: link).font(.notch(9.5, design: .monospaced)).foregroundStyle(Theme.tertiary).lineLimit(2)
                    .truncationMode(.middle).textSelection(.enabled)
                HStack {
                    if copied { Text("Copied.").font(.notch(10)).foregroundStyle(Theme.tertiary) }
                    Spacer()
                    Button(action: copy) { Label("Copy the link", systemImage: "doc.on.doc") }
                        .buttonStyle(NotchButtonStyle(kind: .primary))
                        .keyboardShortcut(.defaultAction)
                }
            } else if failed {
                Text("The invite could not be made. Try again in a moment.").font(.notch(11)).foregroundStyle(Theme.danger)
            } else {
                Text("Making the invite…").font(.notch(11)).foregroundStyle(Theme.tertiary)
            }
        }
    }
}
