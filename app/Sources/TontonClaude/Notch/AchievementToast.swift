import SwiftUI
import TontonCore

/// The badge that drops under the notch when an achievement unlocks.
struct AchievementToast: View {
    let achievement: Achievement

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: achievement.symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.warning)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Theme.warning.opacity(0.16)))
            VStack(alignment: .leading, spacing: 1) {
                Text("Achievement unlocked").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                Text(achievement.title).font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
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
