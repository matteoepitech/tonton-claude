import SwiftUI

enum SettingsPane: String, CaseIterable, Identifiable {
    case machines, usage, notch, general, archive, server
    var id: String { rawValue }

    var title: String {
        switch self {
        case .machines: "Machines"
        case .usage: "Usage"
        case .notch: "Notch"
        case .general: "General"
        case .archive: "Archive"
        case .server: "Relay"
        }
    }

    var subtitle: String {
        switch self {
        case .machines: "Computers running Claude Code with the Tonton Claude agent."
        case .usage: "What your sessions cost, per day, machine and project."
        case .notch: "How the notch opens and lets you know when a session needs you."
        case .general: "Startup, menu bar and keyboard shortcuts."
        case .archive: "Finished conversations kept on this Mac, encrypted, to read later."
        case .server: "The relay server that connects your machines to this Mac."
        }
    }

    var icon: String {
        switch self {
        case .machines: "desktopcomputer"
        case .usage: "chart.bar.xaxis"
        case .notch: "macbook"
        case .general: "gearshape"
        case .archive: "archivebox"
        case .server: "point.3.connected.trianglepath.dotted"
        }
    }
}

// Lets the rest of the app open the settings on a given pane.
@MainActor
final class SettingsRouter: ObservableObject {
    static let shared = SettingsRouter()
    @Published var pane: SettingsPane = AppSettings.shared.isConfigured ? .machines : .server
}

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @ObservedObject private var router = SettingsRouter.shared

    var body: some View {
        HStack(spacing: 0) {
            Sidebar().frame(width: 216)
            Rectangle().fill(Theme.border).frame(width: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    PageHeader(pane: router.pane)
                    Group {
                        switch router.pane {
                        case .machines: MachinesPane()
                        case .usage: UsagePane(usage: store.usage)
                        case .notch: NotchPane()
                        case .general: GeneralPane()
                        case .archive: ArchivePane(archive: store.archive)
                        case .server: RelayPane()
                        }
                    }
                }
                .frame(maxWidth: 620, alignment: .leading)
                .padding(.horizontal, 40)
                .padding(.top, 48)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.never)
        }
        .frame(minWidth: 880, minHeight: 600)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Frosted window: the desktop shows through, blurred, under a dark tint (same feel as the notch).
        .background {
            ZStack {
                VisualEffect(material: Theme.palette.material, alwaysActive: true, scheme: Theme.palette.scheme)
                Theme.bg.opacity(0.8)
            }
        }
        .foregroundStyle(Theme.text)
        .environment(\.colorScheme, Theme.palette.scheme)
        .id(Theme.palette)
        .ignoresSafeArea()
    }
}

struct PageHeader: View {
    let pane: SettingsPane
    @ObservedObject private var router = SettingsRouter.shared

    var body: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 6) {
                Text(pane.title)
                    .font(Theme.title(22))
                    .tracking(-0.4)
                Text(pane.subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textDim)
            }
            Spacer()
        }
        .padding(.bottom, 28)
    }
}

struct Sidebar: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @ObservedObject private var router = SettingsRouter.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                TontonGlyph(size: 22)
                Wordmark(size: 14)
            }
            .padding(.horizontal, 16)
            .padding(.top, 50)
            .padding(.bottom, 22)

            Text("SETTINGS")
                .font(.system(size: 10.5, weight: .medium))
                .tracking(0.6)
                .foregroundStyle(Theme.textFaint)
                .padding(.horizontal, 18)
                .padding(.bottom, 6)
            VStack(spacing: 1) {
                ForEach(SettingsPane.allCases) { pane in
                    NavRow(pane: pane, selected: router.pane == pane) {
                        router.pane = pane
                    }
                }
            }
            .padding(.horizontal, 8)

            Spacer()
            ConnectionFooter()
        }
        .frame(maxHeight: .infinity)
        .background(Theme.ink.opacity(0.025))
    }
}

struct NavRow: View {
    let pane: SettingsPane
    let selected: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: pane.icon).font(.system(size: 12.5)).frame(width: 16)
                Text(pane.title).font(.system(size: 13, weight: .medium))
                Spacer()
            }
            .foregroundStyle(selected ? Theme.text : Theme.textDim)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Theme.hover : (hover ? Theme.raised : .clear)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

struct ConnectionFooter: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore

    private var status: (String, Color) {
        switch store.connection {
        case .connected: ("Connected", Theme.success)
        case .connecting: ("Connecting", Theme.warning)
        case .paused: ("Paused", Theme.textFaint)
        case .notConfigured: ("Not set up", Theme.textFaint)
        case .failed: ("Offline", Theme.danger)
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Circle().fill(status.1).frame(width: 6, height: 6).shadow(color: status.1.opacity(0.7), radius: 3)
                    Text(status.0).font(.system(size: 12, weight: .medium))
                }
                Text(URL(string: settings.relayURL)?.host ?? "no relay")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(Theme.textFaint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 6)
            Toggle("", isOn: $settings.connectionEnabled).toggleStyle(AccentToggleStyle()).labelsHidden().fixedSize()
                .help(settings.connectionEnabled ? "Pause the connection" : "Resume the connection")
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.ink.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.border))
        .padding(10)
    }
}
