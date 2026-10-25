import SwiftUI
import TontonCore

/// Optional dots beside the camera: the most urgent status on the left, the live session count on the right.
struct ActivityDots: View {
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var store: SessionStore

    var body: some View {
        let live = store.visibleSessions.filter { $0.status.isLive }
        let order: [SessionStatus] = [.permission, .error, .waiting, .working, .starting, .idle]
        let urgent = order.first { s in live.contains { $0.status == s } }
        HStack(spacing: 0) {
            if state.showWings {
                Group { if let urgent { StatusDot(status: urgent, size: 7) } }.frame(width: NotchState.wingWidth)
                Spacer(minLength: 0)
                Text("\(live.count)")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(store.attentionCount > 0 ? Theme.warning : .white.opacity(0.6))
                    .frame(width: NotchState.wingWidth)
            }
        }
        .frame(height: state.notchSize.height)
    }
}

struct PeekView: View {
    @EnvironmentObject var state: NotchState

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: state.notchSize.height)
            if let s = state.peekSession {
                HStack(spacing: 8) {
                    StatusDot(status: s.status)
                    Text("\(s.machine) · \(s.project)").font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Text(s.status.label).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                }
                .frame(height: NotchState.peekHeight)
                .padding(.horizontal, 14)
            }
        }
    }
}
