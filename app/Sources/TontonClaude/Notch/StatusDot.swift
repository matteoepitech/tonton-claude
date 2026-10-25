import SwiftUI
import TontonCore

struct StatusDot: View {
    let status: SessionStatus
    var size: CGFloat = 8
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(Color(nsColor: status.color))
            .frame(width: size, height: size)
            .opacity(status == .working && pulse ? 0.35 : 1)
            .animation(status == .working ? .easeInOut(duration: 0.8).repeatForever() : .default, value: pulse)
            .onAppear { pulse = true }
    }
}
