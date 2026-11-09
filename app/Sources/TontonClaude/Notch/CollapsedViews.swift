import SwiftUI
import TontonCore

/// Optional dots beside the camera: the most urgent status on the left, the live session count on the right, or the time
/// left before a usage limit resets when a session is close to it or stopped by it. In Music mode, while music plays, the
/// cover and an equalizer instead (NotchWings).
struct ActivityDots: View {
    @ObservedObject private var rpg = RPGStore.shared
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        let live = store.visibleSessions.filter { $0.status.isLive }
        let urgent = SessionStatus.mostUrgent(live.map(\.status))
        // Sessions of one account share the window; across accounts, the one closest to its limit matters most. Claude's
        // plan only: a Codex session's window is its ChatGPT plan's.
        let limit = UsageLimit.fullest(live.filter { $0.codingTool != .codex }.map(\.fiveHourLimit))
        HStack(spacing: 0) {
            if state.showWings, let activity = state.liveActivity {
                LiveActivityWings(session: activity, mascot: settings.showMascot, width: state.currentWingWidth)
            } else if state.showWings && state.musicWings {
                MusicWings(width: state.currentWingWidth, needsYou: urgent?.needsAttention == true ? urgent : nil)
            } else if state.showWings {
                Group {
                    if settings.showMascot && rpg.ready {
                        // A thin ring of his level's XP; the camera housing is always dark, whatever the theme.
                        LevelRing(progress: rpg.hero.progress, lineWidth: 1.5, track: .white.opacity(0.18)) {
                            MascotView(status: urgent ?? .idle, hero: rpg.hero)
                        }
                        .frame(width: NotchState.wingWidth, height: NotchState.wingWidth)
                        .help(Text("Level \(rpg.hero.level)"))
                    } else if settings.showMascot {
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

/// The wings while music plays in Music mode: the cover on the left, an equalizer on the right. The equalizer takes the
/// color of a session that needs the user, so the wings still say so once its banner is gone.
struct MusicWings: View {
    @ObservedObject private var music = MusicStore.shared
    let width: CGFloat
    let needsYou: SessionStatus?

    var body: some View {
        Group {
            if let cover = music.cover {
                Image(nsImage: cover).resizable().aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "music.note")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.7))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.white.opacity(0.14))
            }
        }
        .frame(width: 18, height: 18)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .frame(width: width)
        .accessibilityElement()
        .accessibilityLabel(music.nowPlaying.map { Text("Now playing: \($0.title), \($0.artist)") } ?? Text("Music playing"))
        Spacer(minLength: 0)
        Equalizer(color: needsYou.map { Color(nsColor: $0.color) } ?? .white.opacity(0.75))
            .frame(width: width)
            .accessibilityElement()
            .accessibilityLabel(needsYou == nil ? Text("Music playing") : Text("A session needs you"))
    }
}

/// Bars rising and falling while music plays. They don't follow the music, which the players don't give; with Reduce
/// Motion they stand still.
struct Equalizer: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var up = false

    /// Each bar's height down and up, as a part of the full height, and the time it takes to go from one to the other.
    private static let bars: [(down: CGFloat, up: CGFloat, duration: Double)] = [
        (0.35, 1, 0.42), (0.8, 0.3, 0.34), (0.3, 0.75, 0.5), (0.65, 0.25, 0.38),
    ]
    static let height: CGFloat = 11

    var body: some View {
        HStack(alignment: .bottom, spacing: 1.5) {
            ForEach(Self.bars.indices, id: \.self) { index in
                let bar = Self.bars[index]
                Capsule()
                    .fill(color)
                    .frame(width: 2.5, height: Self.height)
                    .scaleEffect(y: reduceMotion ? (bar.down + bar.up) / 2 : up ? bar.up : bar.down, anchor: .bottom)
                    .animation(reduceMotion ? nil : .easeInOut(duration: bar.duration).repeatForever(autoreverses: true), value: up)
            }
        }
        .frame(height: Self.height, alignment: .bottom)
        .onAppear { up = true }
    }
}

struct PeekView: View {
    @EnvironmentObject var state: NotchState

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: state.notchSize.height)
            if let s = state.peekSession {
                HStack(spacing: 8) {
                    StatusDot(status: s.status, limit: s.fiveHourLimit, tool: s.codingTool)
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
