import SwiftUI
import TontonCore

struct SessionListView: View {
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var settings: AppSettings
    @State private var query = ""

    var body: some View {
        let sessions = store.visibleSessions.filter {
            query.isEmpty || $0.project.localizedCaseInsensitiveContains(query) || $0.machine.localizedCaseInsensitiveContains(query)
                || ($0.title?.localizedCaseInsensitiveContains(query) ?? false)
        }
        let groups = Dictionary(grouping: sessions, by: \.machine)
        let machines = groups.keys.sorted { a, b in
            let la = groups[a]!.contains { $0.status.isLive }, lb = groups[b]!.contains { $0.status.isLive }
            return la != lb ? la : a.localizedCaseInsensitiveCompare(b) == .orderedAscending
        }
        VStack(spacing: 0) {
            if store.visibleSessions.count > 5 {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 10)).foregroundStyle(.secondary)
                    TextField("", text: $query, prompt: Text("Search sessions").foregroundStyle(.white.opacity(0.35)))
                        .textFieldStyle(.plain)
                        .font(.system(size: 11))
                }
                .padding(.horizontal, 8)
                .frame(height: 26)
                .background(RoundedRectangle(cornerRadius: 7).fill(.white.opacity(0.07)))
                .padding(.trailing, 6)
                .padding(.bottom, 4)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2, pinnedViews: []) {
                    ForEach(machines, id: \.self) { machine in
                        Text(machine.uppercased())
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.top, 8)
                        ForEach(groups[machine]!) { s in
                            SessionRow(session: s, selected: s.id == store.selectedId, showCost: settings.showCosts)
                                .contentShape(Rectangle())
                                .onTapGesture { store.selectedId = s.id }
                                .contextMenu {
                                    Button("Remove from list") { store.dismiss(s.id) }
                                }
                        }
                    }
                }
                .padding(.trailing, 6)
            }
            .scrollIndicators(.never)
        }
    }
}

struct SessionRow: View {
    let session: SessionSummary
    let selected: Bool
    var showCost = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            StatusDot(status: session.status).padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(session.project).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    if !session.pendingPermissions.isEmpty {
                        Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(Theme.accent)
                    }
                    Text(session.lastActivity, style: .relative)
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .frame(maxWidth: 70, alignment: .trailing)
                }
                HStack(alignment: .top, spacing: 6) {
                    Text(session.title ?? session.lastMessage ?? session.status.label)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                    if showCost, let cost = session.costUSD, cost > 0 {
                        Text(String(format: "$%.2f", cost)).font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
                    }
                }
                if session.status.needsAttention {
                    Text(session.displayStatusText)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Color(nsColor: session.status.color))
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 9).fill(selected ? Color.white.opacity(0.12) : .clear))
        .opacity(session.status.isLive ? 1 : 0.55)
    }
}
