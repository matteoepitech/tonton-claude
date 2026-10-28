import SwiftUI
import TontonCore

// The look of the pool views in the notch: cards tinted with the theme's accent, capsule chips and buttons, and a
// progress bar, in the notch's own sizes rather than the system's controls.

/// A capsule button sized for the notch: filled with the accent for the action that matters, quiet otherwise.
struct NotchButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, destructive }
    var kind = Kind.secondary
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(TightLabelStyle())
            .font(.notch(11, weight: .semibold))
            .lineLimit(1)
            .padding(.horizontal, 11)
            .frame(minHeight: 24)
            .foregroundStyle(foreground)
            .background(Capsule().fill(fill))
            .overlay(Capsule().stroke(kind == .primary ? Color.clear : Theme.borderStrong))
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
            .contentShape(Capsule())
    }

    private var foreground: Color {
        switch kind {
        case .primary: Theme.onAccent
        case .secondary: Theme.text
        case .destructive: Theme.danger
        }
    }

    private var fill: AnyShapeStyle {
        switch kind {
        case .primary: AnyShapeStyle(Theme.accentGradient)
        case .secondary: AnyShapeStyle(Theme.raised)
        case .destructive: AnyShapeStyle(Theme.danger.opacity(0.12))
        }
    }
}

/// A small capsule label: a plan, a state, a count.
struct PoolChip: View {
    let text: String
    var systemImage: String?
    var tint = Theme.accent

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage { Image(systemName: systemImage).font(.notch(8.5, weight: .bold)).accessibilityHidden(true) }
            Text(verbatim: text).font(.notch(9.5, weight: .semibold)).lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(tint.opacity(0.14)))
    }
}

extension View {
    /// A pool card: the surface, tinted with the accent when it asks for something.
    func poolCard(highlighted: Bool = false, padding: CGFloat = 10) -> some View {
        self
            .padding(padding)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.accent.opacity(highlighted ? 0.12 : 0)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(highlighted ? Theme.accent.opacity(0.4) : Theme.border))
    }
}

/// How far the pool's tasks are: done over all, as a thin bar.
struct PoolProgress: View {
    let done: Int
    let total: Int

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.raised)
                Capsule().fill(Theme.accentGradient)
                    .frame(width: total > 0 ? max(4, geo.size.width * CGFloat(done) / CGFloat(total)) : 0)
            }
        }
        .frame(height: 5)
        .accessibilityElement()
        .accessibilityLabel(Text("\(done) of \(total) tasks done"))
    }
}

/// The plan the orchestrator proposed, above its conversation: each machine with the tasks it starts, what comes later,
/// and Accept for the owner and admins. To change it, they tell the orchestrator in the conversation below.
struct PoolPlanCard: View {
    let board: PoolBoard
    let state: PoolState
    let plan: PoolState.Post<PoolEventBody>
    @ObservedObject private var pools = PoolStore.shared
    @State private var accepted = false

    var body: some View {
        let lanes = plan.body?.proposal.map(state.planLanes) ?? []
        let count = lanes.reduce(0) { $0 + $1.tasks.count }
        let leads = board.summary.role == .owner || board.summary.role == .admin
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").foregroundStyle(Theme.accent).accessibilityHidden(true)
                Text("The orchestrator's plan").font(.notch(12, weight: .bold)).accessibilityAddTraits(.isHeader)
                Spacer()
                PoolChip(text: String(localized: "\(count) tasks"), tint: Theme.textDim)
            }
            if let text = plan.body?.text {
                Text(text).font(.notch(11)).foregroundStyle(Theme.secondary).lineLimit(5).textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(lanes) { lane in laneView(lane) }
            }
            HStack(spacing: 8) {
                if leads {
                    Text("Or tell it below what to change.").font(.notch(10)).foregroundStyle(Theme.tertiary)
                    Spacer()
                    Button {
                        accepted = true
                        pools.acceptPlan(pool: board.id)
                    } label: {
                        Label("Accept and start", systemImage: "checkmark")
                    }
                    .buttonStyle(NotchButtonStyle(kind: .primary))
                    .disabled(accepted)
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("The dispatch starts: each machine starts its tasks.")
                } else {
                    Text("Waiting for the owner or an admin to accept it.").font(.notch(10)).foregroundStyle(Theme.tertiary)
                }
            }
        }
        .poolCard(highlighted: true)
    }

    private func laneView(_ lane: PoolState.PlanLane) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Image(systemName: lane.machine == nil ? "hourglass" : "desktopcomputer")
                    .font(.notch(10)).foregroundStyle(Theme.tertiary).accessibilityHidden(true)
                if lane.machine == nil {
                    Text("Later").font(.notch(11, weight: .semibold))
                } else {
                    Text(verbatim: lane.name ?? "").font(.notch(11, weight: .semibold)).lineLimit(1)
                    if let owner = lane.owner { Text(verbatim: owner).font(.notch(10)).foregroundStyle(Theme.tertiary).lineLimit(1) }
                }
                Spacer(minLength: 4)
                if let plan = lane.plan { PoolChip(text: plan) }
            }
            ForEach(lane.tasks.prefix(4)) { item in
                Text(verbatim: "· \(item.task?.title ?? "")").font(.notch(10.5)).foregroundStyle(Theme.secondary).lineLimit(1)
            }
            if lane.tasks.count > 4 {
                Text("and \(lane.tasks.count - 4) more").font(.notch(10)).foregroundStyle(Theme.tertiary)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.raised))
    }
}
