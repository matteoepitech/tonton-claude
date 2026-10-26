import SwiftUI
import TontonCore

struct NotchRootView: View {
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var store: SessionStore
    let onSettings: () -> Void

    var body: some View {
        let size = state.currentSize
        let expanded = state.mode == .expanded
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
            Spacer(minLength: 0)
        }
        .frame(width: NotchState.expandedSize.width, height: NotchState.expandedSize.height, alignment: .top)
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
