import SwiftUI
import TontonCore

/// The badge that drops under the notch when an achievement unlocks. Black like the camera housing whatever the theme,
/// so its text is white rather than the theme's.
struct AchievementToast: View {
    let achievement: Achievement

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: achievement.symbol)
                .font(.notch(15, weight: .semibold))
                .foregroundStyle(Theme.warning)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Theme.warning.opacity(0.16)))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text("Achievement unlocked").font(.notch(10, weight: .medium)).foregroundStyle(.white.opacity(0.6))
                Text(achievement.title).font(.notch(13, weight: .bold)).foregroundStyle(.white)
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, 16)
        .padding(.vertical, 7)
        .background(Capsule().fill(.black))
        .overlay(Capsule().stroke(Theme.warning.opacity(0.5)))
        .allowsHitTesting(false)
    }
}
