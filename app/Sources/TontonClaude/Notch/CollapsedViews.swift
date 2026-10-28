import SwiftUI
import TontonCore

/// Optional dots beside the camera: the most urgent status on the left, the live session count on the right, or the time
/// left before a usage limit resets when a session is close to it or stopped by it.
struct ActivityDots: View {
    @ObservedObject private var rpg = RPGStore.shared
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        let live = store.visibleSessions.filter { $0.status.isLive }
        let urgent = SessionStatus.mostUrgent(live.map(\.status))
        // Sessions of one account share the window; across accounts, the one closest to its limit matters most.
        let limit = UsageLimit.fullest(live.map(\.fiveHourLimit))
        HStack(spacing: 0) {
            if state.showWings, let activity = state.liveActivity {
                LiveActivityWings(session: activity, mascot: settings.showMascot, width: state.currentWingWidth)
            } else if state.showWings {
                Group {
                    if settings.showMascot {
                        MascotView(status: urgent ?? .idle, hero: rpg.hero)
                    } else if let urgent {
                        StatusDot(status: urgent, size: 7, limit: limit)
                    }
                }
                .frame(width: state.currentWingWidth)
                Spacer(minLength: 0)
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    let countdown = UsageLimit.soonest(live.map { $0.limitToWatch(at: context.date) }, at: context.date)
                    if state.wingCountdown, let countdown, let level = countdown.level(at: context.date) {
                        Text(countdown.timeLeft(at: context.date))
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundStyle(level.color)
                            .lineLimit(1)
                            .help("A usage limit resets in \(countdown.timeLeft(at: context.date))")
                            .accessibilityLabel("A usage limit resets in \(countdown.timeLeft(at: context.date))")
                    } else {
                        Text("\(live.count)")
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundStyle(store.attentionCount > 0 ? Theme.warning : .white.opacity(0.6))
                            .accessibilityLabel(Spoken.liveSessions(live.count))
                    }
                }
                .frame(width: state.currentWingWidth)
            }
        }
        .frame(height: state.notchSize.height)
    }
}

/// The wings widened around the camera, like the Dynamic Island: the session's status and project on the left, what it
/// needs or works on to the right.
struct LiveActivityWings: View {
    @ObservedObject private var rpg = RPGStore.shared
    let session: SessionSummary
    let mascot: Bool
    let width: CGFloat

    var body: some View {
        HStack(spacing: 6) {
            if mascot { MascotView(status: session.status, size: 16, hero: rpg.hero) } else { StatusDot(status: session.status, size: 7) }
            Text(session.displayName).font(.system(size: 11, weight: .semibold)).lineLimit(1).truncationMode(.tail)
        }
        .padding(.horizontal, 10)
        .frame(width: width, alignment: .leading)
        Spacer(minLength: 0)
        Text(LiveActivity.text(session))
            .font(.system(size: 11))
            .foregroundStyle(session.status.needsAttention ? Color(nsColor: session.status.color) : .white.opacity(0.7))
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 10)
            .frame(width: width, alignment: .leading)
    }
}

struct PeekView: View {
    @EnvironmentObject var state: NotchState

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: state.notchSize.height)
            if let s = state.peekSession {
                HStack(spacing: 8) {
                    StatusDot(status: s.status, limit: s.fiveHourLimit)
                    Text("\(s.machine) · \(s.displayName)").font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Text(state.peekText ?? s.status.label).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                }
                .frame(height: NotchState.peekHeight)
                .padding(.horizontal, 14)
            } else if let text = state.peekText {
                Text(text).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    .frame(height: NotchState.peekHeight)
                    .padding(.horizontal, 14)
            }
        }
    }
}
