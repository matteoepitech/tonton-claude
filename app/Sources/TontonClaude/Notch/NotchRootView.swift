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
                            .padding(.horizontal, 14)
                            .frame(width: NotchState.expandedSize.width, height: NotchState.expandedSize.height)
                    }
                }
                .transition(.opacity.animation(.easeOut(duration: 0.15)))
            }
            .frame(width: size.width, height: size.height)
            .clipShape(shape)
            .overlay(shape.stroke(Color.white.opacity(expanded ? 0.09 : 0), lineWidth: 1))
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
        .environment(\.colorScheme, .dark)
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
                VisualEffect(material: .hudWindow, alwaysActive: true)
                LinearGradient(
                    stops: [
                        .init(color: .black, location: 0),
                        .init(color: .black, location: solid),
                        .init(color: .black.opacity(veil.top), location: min(solid + 0.1, 1)),
                        .init(color: .black.opacity(veil.bottom), location: 1),
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
