import SwiftUI

struct ExpandedView: View {
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var settings: AppSettings
    let onSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // The top band sits under the camera housing: nothing readable goes there.
            Color.clear.frame(height: max(state.notchSize.height, 30))
            Group {
                // Sessions of this Mac show up without an account, so the list comes first.
                if !settings.isConfigured && store.visibleSessions.isEmpty {
                    CenteredMessage(
                        icon: "sparkles", title: "No sessions running",
                        detail: "Start claude in a terminal on this Mac and it shows up here. For your other machines, set up an account.",
                        action: "Set up an account"
                    ) { AppDelegate.shared?.showSettings(pane: .server) }
                } else if store.visibleSessions.isEmpty {
                    CenteredMessage(
                        icon: "sparkles", title: "No sessions running",
                        detail: "Start claude on this Mac or on a machine with the Tonton Claude agent and it shows up here.",
                        action: "Add a machine"
                    ) { AppDelegate.shared?.showSettings(pane: .machines) }
                } else {
                    HStack(spacing: 0) {
                        SessionListView().frame(width: 236)
                        Rectangle().fill(.white.opacity(0.08)).frame(width: 1)
                        if let s = store.selected {
                            ChatPanel(session: s).id(s.id)
                        } else {
                            CenteredMessage(
                                icon: "bubble.left.and.bubble.right", title: "Pick a session", detail: "Select a session on the left.")
                        }
                    }
                }
            }
            .frame(maxHeight: .infinity)
            bottomBar
        }
        .padding(.horizontal, 6)
        .overlay(alignment: .top) {
            if state.showSearch { SearchPanel().padding(.top, max(state.notchSize.height, 30) + 24) }
        }
    }

    private var bottomBar: some View {
        HStack(alignment: .center, spacing: 8) {
            TontonGlyph(size: 16)
            Text("Tonton Claude").font(.system(size: 12, weight: .semibold))
            connectionBadge.padding(.leading, 4)
            Spacer(minLength: 12)
            if settings.showCosts && store.todayCost > 0 {
                Text(String(format: "Today $%.2f", store.todayCost))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.5))
                    .padding(.trailing, 6)
                    .help("Cost of the sessions started today")
            }
            Button {
                state.pinned.toggle()
            } label: {
                Image(systemName: state.pinned ? "pin.fill" : "pin").font(.system(size: 12))
            }
            .buttonStyle(.plain)
            .foregroundStyle(state.pinned ? Theme.accent : .white.opacity(0.7))
            .help(state.pinned ? "Unpin (closes when the pointer leaves)" : "Pin open")
            Button(action: onSettings) { Image(systemName: "gearshape").font(.system(size: 12)) }
                .buttonStyle(.plain)
                .foregroundStyle(.white.opacity(0.7))
                .help("Settings")
        }
        .padding(.horizontal, 14)
        // One band from the divider to the bottom edge, content centered in it.
        .frame(height: 46)
        .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.07)).frame(height: 1) }
    }

    @ViewBuilder private var connectionBadge: some View {
        switch store.connection {
        case .connected:
            HStack(spacing: 5) {
                Circle().fill(Theme.success).frame(width: 6, height: 6)
                Text("connected").font(.system(size: 10)).foregroundStyle(.secondary)
            }
        case .connecting:
            Text("connecting…").font(.system(size: 10)).foregroundStyle(.secondary)
        case .notConfigured:
            Text("this Mac only").font(.system(size: 10)).foregroundStyle(.secondary)
        case .paused:
            Text("disconnected").font(.system(size: 10)).foregroundStyle(.secondary)
        case .failed(let why):
            Text(why).font(.system(size: 10)).foregroundStyle(Theme.danger).lineLimit(1).truncationMode(.tail)
        }
    }
}

struct CenteredMessage: View {
    let icon: String
    let title: String
    let detail: String
    var action: String?
    var perform: (() -> Void)?

    init(icon: String, title: String, detail: String, action: String? = nil, perform: (() -> Void)? = nil) {
        (self.icon, self.title, self.detail, self.action, self.perform) = (icon, title, detail, action, perform)
    }

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 26, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 58, height: 58)
                .background(Circle().fill(.white.opacity(0.08)))
                .overlay(Circle().stroke(.white.opacity(0.12)))
            Text(title).font(.system(size: 15, weight: .semibold))
            Text(detail)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
            if let action, let perform {
                Button(action: perform) {
                    Text(action).font(.system(size: 12, weight: .medium)).padding(.horizontal, 14).padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .background(Capsule().fill(.white.opacity(0.14)))
                .overlay(Capsule().stroke(.white.opacity(0.18)))
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
