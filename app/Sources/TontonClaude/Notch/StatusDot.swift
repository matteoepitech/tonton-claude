import SwiftUI
import TontonCore

struct StatusDot: View {
    let status: SessionStatus
    var size: CGFloat = 8
    /// Drawn as a ring around the dot.
    var limit: UsageLimit?
    /// Whose plan the window is: Codex's is its ChatGPT plan's, and says so.
    var tool: CodingTool = .claudeCode
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(Color(nsColor: status.color))
            .frame(width: size, height: size)
            .opacity(status == .working && pulse ? 0.35 : 1)
            .animation(status == .working ? .easeInOut(duration: 0.8).repeatForever() : .default, value: pulse)
            .onAppear { pulse = true }
            .overlay { if let limit { LimitRing(limit: limit, diameter: size + 6, codex: tool == .codex) } }
            .accessibilityElement()
            .accessibilityLabel(Spoken.status(status, limit: limit))
    }
}

/// How much of the 5-hour window is spent: neutral below 80 %, orange from 80 %, red at the limit. Gone once it resets.
struct LimitRing: View {
    let limit: UsageLimit
    let diameter: CGFloat
    var codex = false

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
                .help(codex ? codexHelp : claudeHelp)
            }
        }
    }
}

extension LimitRing {
    private var claudeHelp: String {
        String(
            localized: """
                5-hour limit: \(Int(limit.usedPercent.rounded())) % used, resets at \
                \(limit.resetsAt.formatted(date: .omitted, time: .shortened))
                """)
    }

    private var codexHelp: String {
        String(
            localized: """
                Codex's 5-hour limit: \(Int(limit.usedPercent.rounded())) % used, resets at \
                \(limit.resetsAt.formatted(date: .omitted, time: .shortened))
                """)
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
