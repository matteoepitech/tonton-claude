import ActivityKit
import SwiftUI
import TontonCore
import WidgetKit

/// The sessions on the Lock Screen and in the Dynamic Island. The state only holds ids, states and sealed blobs: they
/// are opened here, in the extension, with the key the app shares with it.
struct SessionsLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionsActivityAttributes.self) { context in
            let island = Island(context.state)
            LockScreenView(island: island, stale: context.isStale)
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(island.url)
        } dynamicIsland: { context in
            let island = Island(context.state)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    PixelMascot(status: island.status).frame(width: 34, height: 34).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(island.state.summary)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(island.status.tint)
                        .lineLimit(1)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(island.top?.project ?? "Tonton Claude").font(.headline).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(island.lines.prefix(2), id: \.id) { line in
                            if let url = Island.url(for: line.id) {
                                Link(destination: url) { SessionLine(line: line) }
                            } else {
                                SessionLine(line: line)
                            }
                        }
                        if island.lines.isEmpty {
                            Text("Nothing running").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                PixelMascot(status: island.status).frame(width: 20, height: 20)
            } compactTrailing: {
                CompactCount(island: island)
            } minimal: {
                CompactCount(island: island)
            }
            .widgetURL(island.url)
            .keylineTint(island.status.tint)
        }
    }
}

/// The state opened with the account key, or placeholders when it is not on this phone.
struct Island {
    let state: IslandState
    let lines: [IslandLine]

    init(_ state: IslandState) {
        self.state = state
        lines = SharedAccount.vault()?.lines(state) ?? IslandLine.placeholders(state)
    }

    var top: IslandLine? { lines.first }
    var status: SessionStatus { state.status ?? .idle }
    /// Opens the session that needs the user most.
    var url: URL? { top.flatMap { Self.url(for: $0.id) } }

    static func url(for sessionId: String) -> URL? { PhoneLink.session(sessionId).url }
}

struct LockScreenView: View {
    let island: Island
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                PixelMascot(status: island.status).frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Tonton Claude").font(.caption).foregroundStyle(.white.opacity(0.6))
                    Text(island.state.summary).font(.headline).foregroundStyle(.white)
                }
                Spacer(minLength: 0)
            }
            ForEach(island.lines, id: \.id) { line in SessionLine(line: line) }
            if stale {
                Text("Open Tonton Claude to see where the sessions are.").font(.caption2).foregroundStyle(.white.opacity(0.5))
            }
        }
        .padding(14)
    }
}

struct SessionLine: View {
    let line: IslandLine

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: line.status.symbol)
                .font(.caption2.weight(.bold))
                .foregroundStyle(line.status.tint)
                .frame(width: 14)
            Text(line.project).font(.subheadline.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
            if let machine = line.machine {
                Text(machine).font(.caption).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
            }
            Spacer(minLength: 4)
            Text(line.text)
                .font(.caption.weight(line.status.needsAttention ? .semibold : .regular))
                .foregroundStyle(line.status.needsAttention ? line.status.tint : .white.opacity(0.7))
                .lineLimit(1)
        }
    }
}

struct CompactCount: View {
    let island: Island

    var body: some View {
        if island.state.count > 0 {
            HStack(spacing: 2) {
                Image(systemName: island.status.symbol)
                Text("\(island.state.count)")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(island.status.tint)
        } else {
            Image(systemName: "checkmark").font(.caption.weight(.semibold)).foregroundStyle(SessionStatus.idle.tint)
        }
    }
}
