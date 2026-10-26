import SwiftUI
import TontonCore

struct StatusDot: View {
    let status: SessionStatus
    var size: CGFloat = 8
    /// Drawn as a ring around the dot.
    var limit: UsageLimit?
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(Color(nsColor: status.color))
            .frame(width: size, height: size)
            .opacity(status == .working && pulse ? 0.35 : 1)
            .animation(status == .working ? .easeInOut(duration: 0.8).repeatForever() : .default, value: pulse)
            .onAppear { pulse = true }
            .overlay { if let limit { LimitRing(limit: limit, diameter: size + 6) } }
    }
}

/// How much of the 5-hour window is spent: neutral below 80 %, orange from 80 %, red at the limit. Gone once it resets.
struct LimitRing: View {
    let limit: UsageLimit
    let diameter: CGFloat

    var body: some View {
        TimelineView(.everyMinute) { context in
            if let level = limit.level(at: context.date) {
                ZStack {
                    Circle().stroke(.white.opacity(0.14), lineWidth: 1.5)
                    Circle()
                        .trim(from: 0, to: min(max(limit.usedPercent, 0), 100) / 100)
                        .stroke(level.color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: diameter, height: diameter)
                .help(
                    "5-hour limit: \(Int(limit.usedPercent.rounded())) % used, resets at "
                        + limit.resetsAt.formatted(date: .omitted, time: .shortened))
            }
        }
    }
}

extension UsageLimit.Level {
    var color: Color {
        switch self {
        case .normal: .white.opacity(0.55)
        case .high: Color(nsColor: .systemOrange)
        case .reached: Color(nsColor: .systemRed)
        }
    }
}
