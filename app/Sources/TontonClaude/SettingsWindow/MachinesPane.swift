import AppKit
import SwiftUI
import TontonCore

struct MachinesPane: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @ObservedObject private var router = SettingsRouter.shared

    var body: some View {
        if !settings.isConfigured {
            Card {
                VStack(spacing: 10) {
                    IconTile(systemName: "person.crop.circle.badge.plus", size: 40)
                    Text("Set up your account first").font(.system(size: 14, weight: .medium))
                    Text("Machines are tied to an account on a relay.").font(.system(size: 12)).foregroundStyle(Theme.textDim)
                    Button("Open Relay settings") { router.pane = .server }.buttonStyle(ThemeButtonStyle()).padding(.top, 6)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
            }
        } else {
            TokenCard()
            GroupLabel(text: "Phone or browser")
            BrowserPairingCard()
            GroupLabel(text: "Machines")
            if store.machines.isEmpty {
                Card {
                    Text("No machines yet. Run the install command on a computer, then start claude there.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
            } else {
                Card {
                    ForEach(Array(store.machines.enumerated()), id: \.element.id) { index, m in
                        if index > 0 { Hairline() }
                        MachineRow(machine: m)
                        if let request = store.diagnoses[m.id] {
                            Hairline()
                            DiagnosisPanel(
                                machine: m, request: request, repairing: store.repairing[m.id], run: { store.diagnose(m, fix: $0) },
                                close: { store.closeDiagnosis(of: m.id) }
                            ) { AgentUpdateButton(machine: m) }
                        }
                        if let request = store.agentLogs[m.id] {
                            Hairline()
                            AgentLogPanel(
                                machine: m, request: request, refresh: { store.requestLog(of: m) }, close: { store.closeLog(of: m.id) })
                        }
                    }
                }
                Text("Hidden machines keep running, they just stay out of the notch. Revoking a machine signs it out for good.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textFaint)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
                AutoApproveRules()
            }
        }
    }
}

/// The account token and the install commands that carry it. One token for every machine, like a RustDesk server key.
struct TokenCard: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @State private var reveal = false
    @State private var copied = false
    @State private var busy = false
    @State private var error: String?
    @State private var confirmRegenerate = false

    var body: some View {
        let token = settings.account?.machineToken
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Your token").font(.system(size: 13, weight: .medium))
                Text("Machines join your account with it: paste it in the install command, or in the agent's tray icon › Set token.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                if let token {
                    HStack(spacing: 6) {
                        Text(reveal ? token : "tonton_" + String(repeating: "•", count: 32))
                            .font(Theme.mono)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                            .padding(.horizontal, 10)
                            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.code))
                            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.borderStrong))
                        Button {
                            reveal.toggle()
                        } label: {
                            Image(systemName: reveal ? "eye.slash" : "eye").frame(width: 14)
                        }
                        .buttonStyle(ThemeButtonStyle())
                        Button(copied ? "Copied" : "Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(token, forType: .string)
                            copied = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                        }
                        .buttonStyle(ThemeButtonStyle())
                        Button("Regenerate…") { confirmRegenerate = true }.buttonStyle(ThemeButtonStyle()).disabled(busy)
                    }
                } else if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Button("Get a new token") { confirmRegenerate = true }.buttonStyle(ThemeButtonStyle())
                }
                if let error {
                    Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(16)
            if let token {
                Hairline()
                CodeRow(
                    label: "Windows", hint: "PowerShell", command: InstallCommand.windows(token: token),
                    masked: InstallCommand.windows(token: "tonton_•••"))
                Hairline()
                CodeRow(
                    label: "macOS & Linux", hint: "Terminal", command: InstallCommand.unix(token: token),
                    masked: InstallCommand.unix(token: "tonton_•••"))
            }
        }
        .task { await run { try await store.createMachineToken() } }
        .confirmationDialog("Regenerate the token?", isPresented: $confirmRegenerate) {
            Button("Regenerate", role: .destructive) { Task { await run { try await store.regenerateMachineToken() } } }
        } message: {
            Text(
                """
                The current token stops working right away: every machine is signed out until you give it the new one. \
                Other Macs signed in to this account need the new recovery key.
                """)
        }
    }

    private func run(_ work: () async throws -> Void) async {
        busy = true
        error = nil
        do { try await work() } catch { self.error = error.localizedDescription }
        busy = false
    }
}

struct MachineRow: View {
    let machine: MachineInfo
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @State private var confirmRevoke = false
    @State private var wakeSent = false
    @State private var pickingStyle = false

    var body: some View {
        let sessions = store.sessions.filter { $0.machineId == machine.id }
        let live = sessions.filter { $0.status.isLive }.count
        let visible = Binding(
            get: { !settings.hiddenMachines.contains(machine.name) },
            set: { on in if on { settings.hiddenMachines.remove(machine.name) } else { settings.hiddenMachines.insert(machine.name) } }
        )
        HStack(spacing: 12) {
            styleButton
            VStack(alignment: .leading, spacing: 3) {
                Text(machine.name).font(.system(size: 13, weight: .medium))
                Text(subtitle(sessions: sessions.count))
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(Theme.textFaint)
                if machine.online, let health = machine.health {
                    Text(health.summary)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(health.isStale() ? Theme.textFaint : Theme.textDim)
                        .help(health.isStale() ? "No report for a few minutes" : "Reported by the machine every minute")
                }
                if let error = store.updateErrors[machine.id] {
                    Text(error).font(.system(size: 11.5)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer()
            if !machine.online, let targets = machine.health?.wake, !targets.isEmpty {
                Button(wakeSent ? "Sent" : "Wake") {
                    WakeOnLAN.wake(targets)
                    wakeSent = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { wakeSent = false }
                }
                .buttonStyle(ThemeButtonStyle())
                .help("Sends a Wake-on-LAN packet on this Mac's network. \(machine.name) must be on the same network, with Wake-on-LAN on.")
            }
            AgentUpdateButton(machine: machine)
            HStack(spacing: 5) {
                Circle().fill(machine.online ? Theme.success : Theme.textFaint).frame(width: 6, height: 6)
                Text(live > 0 ? "\(live) live" : (machine.online ? "Online" : "Offline")).font(.system(size: 12)).foregroundStyle(
                    Theme.textDim)
                    .fixedSize()
            }
            // Wider when a language needs it, rather than cut.
            .frame(minWidth: 70, alignment: .leading)
            Toggle("", isOn: visible).toggleStyle(AccentToggleStyle()).labelsHidden().fixedSize()
                .help(visible.wrappedValue ? "Shown in the notch" : "Hidden from the notch")
            Menu {
                Button("Diagnose") { store.diagnose(machine) }.disabled(!machine.online)
                Button("Show agent log") { store.requestLog(of: machine) }.disabled(!machine.online)
                Divider()
                Button("Revoke access…", role: .destructive) { confirmRevoke = true }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 12)).foregroundStyle(Theme.textDim).frame(width: 22, height: 22)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .confirmationDialog("Revoke \(machine.name)?", isPresented: $confirmRevoke) {
            Button("Revoke", role: .destructive) { Task { try? await store.revoke(machine) } }
        } message: {
            Text("The machine is signed out immediately. You can add it again later with a new install command.")
        }
    }

    /// The machine's icon, or its platform's: a click picks another icon and a color.
    private var styleButton: some View {
        let style = Binding(
            get: { settings.machineStyles[machine.id] ?? MachineStyle() },
            set: { settings.machineStyles[machine.id] = $0.isEmpty ? nil : $0 })
        return Button {
            pickingStyle = true
        } label: {
            ZStack {
                if style.wrappedValue.symbol == nil {
                    IconTile(systemName: icon, tint: MachineBadge.color(style.wrappedValue.color) ?? Theme.textDim)
                } else {
                    MachineBadge(style: style.wrappedValue, size: 14)
                        .frame(width: 30, height: 30)
                        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.raised))
                        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.border))
                }
            }
        }
        .buttonStyle(.plain)
        .help("Pick an icon and a color for \(machine.name)")
        .popover(isPresented: $pickingStyle, arrowEdge: .bottom) { MachineStylePicker(style: style) }
    }

    private func subtitle(sessions: Int) -> String {
        let count = String(localized: "\(sessions) sessions")
        let when = (machine.lastSeen ?? machine.createdAt).formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
        let seen = String(localized: "\(count) · seen \(when)", comment: "3 sessions · seen 2 hr. ago")
        return machine.agentVersion.map { String(localized: "\(seen) · agent \($0)", comment: "The agent's version") } ?? seen
    }

    /// The reported platform, or for older agents the one of their sessions, or a guess from the name.
    private var icon: String {
        let platform = machine.platform ?? store.sessions.first { $0.machineId == machine.id }?.platform
        switch platform {
        case "win32": return "pc"
        case "linux": return "server.rack"
        case "darwin": return "laptopcomputer"
        default:
            let name = machine.name.uppercased()
            return name.contains("WIN") || name.hasPrefix("DESKTOP-") || name.contains("PC") ? "pc" : "laptopcomputer"
        }
    }
}

/// Updates the machine's agent in one click, or for agents too old to do it, copies the command to run there once.
struct AgentUpdateButton: View {
    let machine: MachineInfo
    @EnvironmentObject var store: SessionStore
    @State private var copied = false

    var body: some View {
        let latest = store.agentVersion ?? ""
        switch machine.agentUpdate(to: store.agentVersion) {
        case .oneClick:
            if store.updatingMachines.contains(machine.id) {
                ProgressView().controlSize(.small).frame(width: 60)
            } else {
                Button("Update") { store.updateAgent(machine) }
                    .buttonStyle(ThemeButtonStyle(primary: true))
                    .help("Install agent \(latest) on this machine. Running sessions switch to it when they restart.")
            }
        case .manual:
            Button(copied ? "Copied" : "Update…") {
                let command = store.manualUpdateCommand(for: machine)
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(command, forType: .string)
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
            }
            .buttonStyle(ThemeButtonStyle())
            .help("This agent is too old to update from here. Copies the command to paste once in a terminal on the machine.")
        case nil:
            EmptyView()
        }
    }
}

struct CodeRow: View {
    let label: String
    let hint: String
    let command: String
    let masked: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(label).font(.system(size: 12, weight: .medium))
                Text(hint).font(.system(size: 12)).foregroundStyle(Theme.textFaint)
            }
            HStack(spacing: 8) {
                Text("$").font(Theme.mono).foregroundStyle(Theme.textFaint)
                Text(masked).font(Theme.mono).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(command, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 11))
                        .foregroundStyle(copied ? Theme.success : Theme.textDim)
                        .frame(width: 26, height: 26)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.raised))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border))
                }
                .buttonStyle(.plain)
                .help("Copy the full command")
            }
            .padding(.leading, 12)
            .padding(.trailing, 6)
            .frame(height: 38)
            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.bg))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.border))
        }
        .padding(16)
    }
}
