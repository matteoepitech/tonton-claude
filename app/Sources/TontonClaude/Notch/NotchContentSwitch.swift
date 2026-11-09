import SwiftUI
import TontonCore

/// The band at the top of the open notch: the camera housing in the middle, Sessions | Music beside it on the left. The
/// band is solid black like the housing, so the switch is light whatever the theme, and keeps its size whatever the text
/// size, like the closed notch.
struct NotchTopBand: View {
    @EnvironmentObject var state: NotchState

    var body: some View {
        HStack(spacing: 0) {
            NotchContentSwitch().padding(.trailing, 12).frame(maxWidth: .infinity, alignment: .trailing)
            // The camera: the paddings around the band are the same on both sides, so it sits in the middle.
            Color.clear.frame(width: state.notchSize.width)
            Color.clear.frame(maxWidth: .infinity)
        }
        .frame(height: max(state.notchSize.height, 30))
    }
}

/// Sessions | Music (⌘M). While the music shows, a dot on Sessions says a session needs the user.
struct NotchContentSwitch: View {
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var store: SessionStore

    var body: some View {
        let shown = state.content.shown
        let urgent = SessionStatus.mostUrgent(store.visibleSessions.filter(\.status.needsAttention).map(\.status))
        HStack(spacing: 2) {
            segment(.sessions, "Sessions", icon: "rectangle.stack", help: "Show the sessions (⌘M)", badge: shown == .music ? urgent : nil)
            segment(.music, "Music", icon: "music.note", help: "Show the music (⌘M)")
        }
        .padding(2)
        .background(Capsule().fill(.white.opacity(0.08)))
        .overlay(Capsule().strokeBorder(.white.opacity(0.1)))
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Notch content")
    }

    private func segment(
        _ content: NotchContent, _ title: LocalizedStringKey, icon: String, help: LocalizedStringKey, badge: SessionStatus? = nil
    ) -> some View {
        let selected = state.content.shown == content
        return Button {
            withAnimation(.easeOut(duration: 0.15)) { state.content = state.content.picking(content) }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 9, weight: .semibold)).accessibilityHidden(true)
                Text(title).font(.system(size: 11, weight: .medium)).lineLimit(1)
                if let badge {
                    Circle().fill(Color(nsColor: badge.color)).frame(width: 5, height: 5).accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 9)
            .frame(height: 20)
            .foregroundStyle(.white.opacity(selected ? 0.95 : 0.55))
            .background(Capsule().fill(.white.opacity(selected ? 0.16 : 0)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityValue(badge == nil ? "" : String(localized: "A session needs you"))
    }
}
