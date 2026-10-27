import SwiftUI

/// The git branch a session works on, in the chat header next to the model. A long name keeps its start and its end,
/// so the title next to it keeps its room.
struct BranchLabel: View {
    let branch: String
    private static let maxCharacters = 24

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 9))
            Text(Self.shortened(branch)).font(.system(size: 10, design: .monospaced)).lineLimit(1)
        }
        .foregroundStyle(.secondary)
        .fixedSize()
        .help("The git branch of the session's folder: \(branch)")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Branch \(branch)")
    }

    static func shortened(_ branch: String) -> String {
        guard branch.count > maxCharacters else { return branch }
        let half = (maxCharacters - 1) / 2
        return "\(branch.prefix(half))…\(branch.suffix(half))"
    }
}
