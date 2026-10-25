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
        } else if router.installing {
            InstallSteps()
        } else if store.machines.isEmpty {
            Card {
                VStack(spacing: 10) {
                    IconTile(systemName: "desktopcomputer", size: 40)
                    Text("No machines yet").font(.system(size: 14, weight: .medium))
                    Text("Install the agent on a computer, then start claude there.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textDim)
                    Button {
                        router.installing = true
                    } label: {
                        Label("Add machine", systemImage: "plus")
                    }
                    .buttonStyle(ThemeButtonStyle())
                    .padding(.top, 6)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
            }
        } else {
            Card {
                ForEach(Array(store.machines.enumerated()), id: \.element.id) { index, m in
                    if index > 0 { Hairline() }
                    MachineRow(machine: m)
                }
            }
            Text("Hidden machines keep running, they just stay out of the notch. Revoking a machine signs it out for good.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textFaint)
                .padding(.top, 10)
        }
    }
}

struct MachineRow: View {
    let machine: MachineInfo
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @State private var confirmRevoke = false

    var body: some View {
        let sessions = store.sessions.filter { $0.machineId == machine.id }
        let live = sessions.filter { $0.status.isLive }.count
        let visible = Binding(
            get: { !settings.hiddenMachines.contains(machine.name) },
            set: { on in if on { settings.hiddenMachines.remove(machine.name) } else { settings.hiddenMachines.insert(machine.name) } }
        )
        HStack(spacing: 12) {
            IconTile(systemName: icon)
            VStack(alignment: .leading, spacing: 3) {
                Text(machine.name).font(.system(size: 13, weight: .medium))
                Text(subtitle(sessions: sessions.count))
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(Theme.textFaint)
            }
            Spacer()
            HStack(spacing: 5) {
                Circle().fill(machine.online ? Theme.success : Theme.textFaint).frame(width: 6, height: 6)
                Text(live > 0 ? "\(live) live" : (machine.online ? "Online" : "Offline")).font(.system(size: 12)).foregroundStyle(
                    Theme.textDim)
            }
            .frame(width: 70, alignment: .leading)
            Toggle("", isOn: visible).toggleStyle(AccentToggleStyle()).labelsHidden().fixedSize()
                .help(visible.wrappedValue ? "Shown in the notch" : "Hidden from the notch")
            Menu {
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

    private func subtitle(sessions: Int) -> String {
        let when = (machine.lastSeen ?? machine.createdAt).formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
        return "\(sessions) session\(sessions == 1 ? "" : "s") · seen \(when)"
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

struct InstallSteps: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: SessionStore
    @State private var enrollment: Enrollment?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Step(
                number: 1, title: "Install the agent",
                detail: "Paste the line for the machine's system in a terminal. The code works once and expires in 15 minutes.")
            Card {
                if let enrollment, let account = settings.account {
                    let enroll = "\(enrollment.code).\(account.key)"
                    let masked = "\(enrollment.code).•••"
                    CodeRow(
                        label: "Windows", hint: "PowerShell",
                        command: "$env:TONTON_ENROLL='\(enroll)'; irm \(account.relay)/install.ps1 | iex",
                        masked: "$env:TONTON_ENROLL='\(masked)'; irm \(account.relay)/install.ps1 | iex")
                    Hairline()
                    CodeRow(
                        label: "macOS & Linux", hint: "Terminal",
                        command: "curl -fsSL \(account.relay)/install.sh | TONTON_ENROLL='\(enroll)' sh",
                        masked: "curl -fsSL \(account.relay)/install.sh | TONTON_ENROLL='\(masked)' sh")
                    Hairline()
                    HStack {
                        Image(systemName: "lock").font(.system(size: 11)).foregroundStyle(Theme.textFaint)
                        Text("The command carries your encryption key: it is never sent to the relay.")
                            .font(.system(size: 11.5))
                            .foregroundStyle(Theme.textFaint)
                        Spacer()
                        Button("New code") { Task { await refresh() } }.buttonStyle(ThemeButtonStyle())
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                } else if let error {
                    Row(title: "Could not create a code", detail: error) {
                        Button("Retry") { Task { await refresh() } }.buttonStyle(ThemeButtonStyle())
                    }
                } else {
                    HStack {
                        Spacer(); ProgressView().controlSize(.small); Spacer()
                    }.padding(24)
                }
            }
            .padding(.leading, 34)
            Step(
                number: 2, title: "Start claude in a new terminal",
                detail: "Confirm “I am using this for local development” once. The machine then shows up here and in the notch."
            )
            .padding(.top, 24)
        }
        .task { await refresh() }
    }

    private func refresh() async {
        error = nil
        do {
            enrollment = try await store.newEnrollment()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct Step: View {
    let number: Int
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.text)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Theme.raised))
                .overlay(Circle().stroke(Theme.borderStrong))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13, weight: .medium))
                Text(detail).font(.system(size: 12)).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.bottom, 12)
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
