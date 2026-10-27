import SwiftUI
import TontonCore

struct NotchRootView: View {
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var settings: AppSettings
    let onSettings: () -> Void

    var body: some View {
        let size = state.currentSize
        let expanded = state.mode == .expanded
        let glow = settings.workingGlow ? SessionStatus.glow(store.visibleSessions.filter(\.status.isLive).map(\.status)) : nil
        /// Collapsed: plain rounded bottom like the hardware notch. Open: concave flares at the top.
        let shape =
            switch state.mode {
            case .collapsed: NotchShape(topRadius: 0, bottomRadius: 8)
            case .peek: NotchShape(topRadius: 6, bottomRadius: 14)
            case .expanded: NotchShape(topRadius: 14, bottomRadius: 26)
            }
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                if expanded {
                    GlassBackground(headerHeight: max(state.notchSize.height, 30))
                } else {
                    Color.black
                }
                Group {
                    switch state.mode {
                    case .collapsed: ActivityDots()
                    case .peek: PeekView()
                    case .expanded:
                        // Laid out once at its final size and revealed by the animated clip: resizing the conversation and its
                        // text field on every frame of the spring made opening and closing stutter.
                        ExpandedView(onSettings: onSettings)
                            // Its fonts read the text size (Font.notch): a new size redraws all of it.
                            .id(settings.notchTextSize)
                            .foregroundStyle(Theme.text)
                            .padding(.horizontal, 14)
                            .frame(width: NotchState.expandedSize.width, height: NotchState.expandedSize.height)
                    }
                }
                .transition(.opacity.animation(.easeOut(duration: 0.15)))
            }
            .frame(width: size.width, height: size.height)
            .clipShape(shape)
            .overlay(shape.stroke(Theme.line(expanded ? 0.09 : 0), lineWidth: 1))
            .overlay {
                if let glow { NotchGlow(shape: shape, color: Color(nsColor: glow.color)).frame(width: size.width, height: size.height) }
            }
            Spacer(minLength: 0)
        }
        .frame(width: NotchState.expandedSize.width, height: NotchState.expandedSize.height, alignment: .top)
        .overlay(alignment: .top) {
            if let achievement = state.achievement {
                AchievementToast(achievement: achievement)
                    .padding(.top, size.height + 8)
                    .transition(.scale(scale: 0.6, anchor: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.7), value: state.achievement)
        .overlay {
            if let seed = state.confetti { ConfettiBurst(seed: seed, from: CGPoint(x: NotchState.expandedSize.width / 2, y: size.height)) }
        }
        .overlay(alignment: .top) {
            if state.mode == .collapsed && state.pills.pillCount > 0 {
                SessionPills(row: state.pills).padding(.top, state.collapsedSize.height + NotchState.pillGap)
            }
        }
        .overlay(alignment: .topLeading) {
            if state.mode == .collapsed, let index = state.previewPill, state.pills.sessions.indices.contains(index) {
                let top = state.collapsedSize.height + NotchState.pillGap + NotchState.pillHeight + PillRow.previewGap
                PillPreview(session: state.pills.sessions[index])
                    .offset(x: state.pills.previewX(for: index, within: NotchState.expandedSize.width), y: top)
                    .transition(.opacity)
            }
        }
        // The closed notch, its pills and the banner are part of the camera housing: always dark.
        .environment(\.colorScheme, expanded ? Theme.palette.scheme : .dark)
        .id(Theme.palette)
    }
}

/// Frosted glass: solid black where it meets the camera housing, then the desktop shows through, blurred, as much as the
/// transparency setting lets it.
struct GlassBackground: View {
    let headerHeight: CGFloat
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        GeometryReader { geo in
            let h = max(geo.size.height, 1)
            let solid = headerHeight / h
            let veil = GlassVeil(transparency: settings.notchTransparency)
            ZStack {
                VisualEffect(material: Theme.palette.material, alwaysActive: true, scheme: Theme.palette.scheme)
                LinearGradient(
                    stops: [
                        .init(color: .black, location: 0),
                        .init(color: .black, location: solid),
                        .init(color: Theme.palette.veil.opacity(veil.top), location: min(solid + 0.1, 1)),
                        .init(color: Theme.palette.veil.opacity(veil.bottom), location: 1),
                    ], startPoint: .top, endPoint: .bottom)
                RadialGradient(
                    colors: [Theme.accent.opacity(0.05), .clear], center: .bottomLeading, startRadius: 0, endRadius: geo.size.width * 0.7)
            }
        }
    }
}

/// A light running around the notch's outline while a session works. It stays still with Reduce Motion.
struct NotchGlow: View {
    let shape: NotchShape
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var angle = 0.0

    var body: some View {
        GeometryReader { geo in
            // A cone of light turning around the center, seen only through the outline.
            let side = hypot(geo.size.width, geo.size.height)
            let light = AngularGradient(colors: [color.opacity(0), color, color.opacity(0), color.opacity(0)], center: .center)
            ZStack {
                if reduceMotion {
                    color.opacity(0.7)
                } else {
                    light.frame(width: side, height: side).rotationEffect(.degrees(angle))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .mask(shape.stroke(lineWidth: 1.5))
            .background {
                // The halo: the same light, wider and blurred.
                ZStack {
                    if reduceMotion {
                        color.opacity(0.35)
                    } else {
                        light.frame(width: side, height: side).rotationEffect(.degrees(angle))
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .mask(shape.stroke(lineWidth: 5))
                .blur(radius: 4)
                .opacity(0.7)
            }
        }
        .allowsHitTesting(false)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) { angle = 360 }
        }
    }
}

/// Confetti bursting out from under the notch and falling down the screen.
struct ConfettiBurst: View {
    let seed: UInt64
    let from: CGPoint
    @State private var start = Date()

    private static let colors: [Color] = [
        Theme.accent, Theme.success, Theme.warning, Theme.danger, .white, Color(nsColor: .systemTeal),
    ]

    var body: some View {
        let pieces = Confetti.pieces(seed: seed, colors: Self.colors.count)
        TimelineView(.animation) { context in
            Canvas { graphics, _ in
                let time = context.date.timeIntervalSince(start)
                for piece in pieces {
                    let placement = Confetti.placement(of: piece, at: time, from: from)
                    var pen = graphics
                    pen.opacity = placement.opacity
                    pen.translateBy(x: placement.position.x, y: placement.position.y)
                    pen.rotate(by: .radians(placement.angle))
                    let size = piece.size
                    pen.fill(
                        Path(CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height)),
                        with: .color(Self.colors[piece.color]))
                }
            }
        }
        .allowsHitTesting(false)
    }
}

/// The session of a pill the pointer rests on: where it runs, what it does and its last message. A click opens it, like a
/// click on the pill; the window controller handles both.
struct PillPreview: View {
    let session: SessionSummary

    private var text: String {
        if session.status.needsAttention { return session.displayStatusText }
        return session.lastMessage ?? session.title ?? session.status.label
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                StatusDot(status: session.status, size: 6)
                Text(session.displayName).font(.system(size: 11, weight: .semibold)).lineLimit(1)
                Text(session.machine).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 4)
                Text(session.status.label).font(.system(size: 10)).foregroundStyle(Color(nsColor: session.status.color))
            }
            Text(text.trimmingCharacters(in: .whitespacesAndNewlines))
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.75))
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.white)
        .padding(10)
        .frame(width: PillRow.previewWidth, height: PillRow.previewHeight, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 12).fill(.black.opacity(0.92)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.white.opacity(0.12)))
        .allowsHitTesting(false)
    }
}

/// Live sessions as small pills under the collapsed notch, readable without opening it. Clicks are handled by the window
/// controller, which knows where the pointer is.
struct SessionPills: View {
    let row: PillRow

    var body: some View {
        HStack(spacing: PillRow.spacing) {
            ForEach(row.sessions) { session in
                pill {
                    StatusDot(status: session.status, size: 6)
                    Text(session.displayName).font(.system(size: 10, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                }
                .overlay(Capsule().stroke(Color(nsColor: session.status.color).opacity(session.status.needsAttention ? 0.9 : 0.35)))
                .accessibilityElement(children: .combine)
            }
            if row.more > 0 {
                pill { Text("+\(row.more)").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary) }
                    .overlay(Capsule().stroke(.white.opacity(0.15)))
                    .accessibilityLabel(Spoken.moreSessions(row.more))
            }
        }
        .allowsHitTesting(false)
    }

    private func pill<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 5) { content() }
            .padding(.horizontal, 8)
            .frame(width: PillRow.pillWidth, height: NotchState.pillHeight)
            .background(Capsule().fill(.black.opacity(0.88)))
    }
}
