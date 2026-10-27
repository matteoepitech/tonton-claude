import SwiftUI
import TontonCore

/// ⌘N in the open notch: pick a machine and a folder, and its agent starts claude there. The questions Claude Code asks
/// on the way show up here until the session runs.
struct NewSessionPanel: View {
    @EnvironmentObject var state: NotchState
    @EnvironmentObject var store: SessionStore
    @EnvironmentObject var settings: AppSettings
    @State private var machineId: String?
    @State private var folder = ""
    @State private var tool = CodingTool.claudeCode
    @FocusState private var focused: Bool

    var body: some View {
        // This Mac first, then by name.
        let machines = store.machines.sorted {
            ($0.id == store.thisMac ? 0 : 1, $0.name.lowercased()) < ($1.id == store.thisMac ? 0 : 1, $1.name.lowercased())
        }
        let machine = machines.first { $0.id == machineId && canStart($0) }
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("New session").font(.notch(13, weight: .semibold))
                Spacer()
                Button {
                    state.showNewSession = false
                } label: {
                    Image(systemName: "xmark").font(.notch(10, weight: .semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.secondary)
                .help("Close (esc)")
                .accessibilityLabel("Close")
            }
            .padding(.bottom, 10)
            if machines.isEmpty {
                Text("No machine is linked to the account yet. Add one in Settings › Machines.")
                    .font(.notch(12))
                    .foregroundStyle(Theme.secondary)
            } else {
                machinePicker(machines)
                if let machine, machine.startableTools.count > 1 { toolPicker(machine) }
                folderField(machine)
                if let machine { recentFolders(machine) }
            }
            ForEach(store.launches) { launch in
                LaunchCard(launch: launch, machine: store.machines.first { $0.id == launch.machineId }?.name ?? "the machine")
                    .padding(.top, 10)
            }
        }
        .padding(14)
        .frame(width: 440)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.borderStrong))
        .shadow(color: .black.opacity(0.5), radius: 20, y: 8)
        .onAppear {
            machineId = machineId ?? (machines.first { $0.id == store.selected?.machineId } ?? machines.first(where: canStart))?.id
            focused = true
        }
    }

    private func machinePicker(_ machines: [MachineInfo]) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(machines) { machine in
                    let selected = machine.id == machineId
                    Button {
                        machineId = machine.id
                        focused = true
                    } label: {
                        HStack(spacing: 5) {
                            if let style = settings.machineStyles[machine.id] {
                                MachineBadge(style: style, size: 10).accessibilityHidden(true)
                            }
                            Text(store.thisMac == machine.id ? "This Mac" : machine.name).font(.notch(11, weight: .medium))
                        }
                        .padding(.horizontal, 10)
                        .frame(height: 24)
                        .background(Capsule().fill(selected ? Theme.accent.opacity(0.28) : Theme.ink.opacity(0.07)))
                        .overlay(Capsule().stroke(selected ? Theme.accent.opacity(0.6) : .clear))
                    }
                    .buttonStyle(.plain)
                    .disabled(!canStart(machine))
                    .opacity(canStart(machine) ? 1 : 0.4)
                    .help(why(machine) ?? "Start a session on \(machine.name)")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
        .scrollIndicators(.never)
        .padding(.bottom, 8)
    }

    /// Claude Code or OpenCode, when the machine has both.
    private func toolPicker(_ machine: MachineInfo) -> some View {
        HStack(spacing: 6) {
            ForEach(machine.startableTools, id: \.self) { choice in
                let selected = choice == chosenTool(machine)
                Button {
                    tool = choice
                    focused = true
                } label: {
                    HStack(spacing: 5) {
                        ToolMark(tool: choice, size: 10).accessibilityHidden(true)
                        Text(choice.label).font(.notch(11, weight: .medium))
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 24)
                    .background(Capsule().fill(selected ? Theme.accent.opacity(0.28) : Theme.ink.opacity(0.07)))
                    .overlay(Capsule().stroke(selected ? Theme.accent.opacity(0.6) : .clear))
                }
                .buttonStyle(.plain)
                .help("Start \(choice.command) on \(machine.name)")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(.bottom, 8)
    }

    /// The tool picked, or the first one the machine has when it lacks it.
    private func chosenTool(_ machine: MachineInfo?) -> CodingTool {
        guard let machine else { return tool }
        return machine.startableTools.contains(tool) ? tool : machine.startableTools.first ?? .claudeCode
    }

    private func folderField(_ machine: MachineInfo?) -> some View {
        let startable = machine != nil && RecentFolders.isStartable(folder) && store.connection == .connected
        return HStack(spacing: 8) {
            Image(systemName: "folder").font(.notch(11)).foregroundStyle(Theme.secondary).accessibilityHidden(true)
            TextField("", text: $folder, prompt: Text("~/code/project").foregroundStyle(Theme.textFaint))
                .accessibilityLabel("Folder")
                .textFieldStyle(.plain)
                .font(.notch(12, design: .monospaced))
                .focused($focused)
                .onSubmit { if startable, let machine { start(machine) } }
            Button {
                if let machine { start(machine) }
            } label: {
                Text("Start").font(.notch(11, weight: .semibold)).padding(.horizontal, 10).frame(height: 22)
                    .foregroundStyle(startable ? Theme.onAccent : Theme.text)
                    .background(Capsule().fill(startable ? Theme.accent : Theme.ink.opacity(0.1)))
            }
            .buttonStyle(.plain)
            .disabled(!startable)
            .help(startable ? "Start \(chosenTool(machine).command) in this folder" : "A full path, or one that starts with ~/")
        }
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.ink.opacity(0.07)))
    }

    @ViewBuilder private func recentFolders(_ machine: MachineInfo) -> some View {
        let folders = store.recentFolders(on: machine.id)
        if !folders.isEmpty {
            Text("RECENT").font(.notch(10, weight: .semibold)).foregroundStyle(Theme.secondary).padding(.top, 10).padding(.bottom, 2)
            ForEach(folders, id: \.self) { recent in
                HStack(spacing: 8) {
                    Image(systemName: "clock.arrow.circlepath").font(.notch(10)).foregroundStyle(Theme.tertiary).accessibilityHidden(true)
                    Text(recent).font(.notch(11, design: .monospaced)).lineLimit(1).truncationMode(.head)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 6)
                .frame(height: 22)
                .background(RoundedRectangle(cornerRadius: 6).fill(recent == folder ? Theme.ink.opacity(0.1) : .clear))
                .contentShape(Rectangle())
                .onTapGesture(count: 2) {
                    folder = recent
                    start(machine)
                }
                .onTapGesture { folder = recent }
                .help("Click to pick, double-click to start")
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { folder = recent }
                .accessibilityAction(named: "Start here") {
                    folder = recent
                    start(machine)
                }
            }
        }
    }

    private func start(_ machine: MachineInfo) {
        store.startSession(on: machine, in: folder, tool: chosenTool(machine))
        folder = ""
    }

    private func canStart(_ machine: MachineInfo) -> Bool { why(machine) == nil }

    /// Why no session can start on the machine from here, if it cannot.
    private func why(_ machine: MachineInfo) -> String? {
        let platform = machine.platform ?? store.sessions.first { $0.machineId == machine.id }?.platform
        if platform == "win32" { return "Starting sessions needs tmux, which Windows does not have" }
        if !machine.online { return "\(machine.name) is offline" }
        return nil
    }
}

/// Where a start stands, and the question Claude Code asks, with its screen, until the user answers.
private struct LaunchCard: View {
    let launch: SessionLaunch
    let machine: String
    @EnvironmentObject var store: SessionStore
    /// A question opens the notch by itself: a click meant for something else must not answer it.
    @State private var armed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                switch launch.state {
                case .sending, .starting, .started: ProgressView().controlSize(.mini)
                case .asking: Image(systemName: "questionmark.circle.fill").foregroundStyle(Theme.accent).accessibilityLabel("Question")
                case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.danger).accessibilityLabel("Failed")
                }
                Text("\(launch.cwd) on \(machine)").font(.notch(11, weight: .medium)).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 0)
                if launch.state == .failed {
                    Button {
                        store.dismissLaunch(launch.id)
                    } label: {
                        Image(systemName: "xmark").font(.notch(9, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.secondary)
                    .help("Dismiss")
                    .accessibilityLabel("Dismiss")
                }
            }
            switch launch.state {
            case .sending: caption("Sending the order…")
            case .starting, .started: caption("Starting \(launch.tool.command)…")
            case .asking, .failed:
                if let headline = launch.headline {
                    Text(headline).font(.notch(12)).foregroundStyle(launch.state == .failed ? Theme.danger : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let screen = launch.screen, launch.state == .asking || launch.state == .failed {
                // As tall as the screen up to a point, then scrolled to its last lines, where the choices are.
                HeightLimit(limit: 110) {
                    ViewThatFits(in: .vertical) {
                        screenText(screen)
                        ScrollView { screenText(screen) }.defaultScrollAnchor(.bottom)
                    }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.code))
            }
            if launch.state == .asking {
                HStack(spacing: 8) {
                    Spacer()
                    Button("Cancel") { store.answerStart(launch, confirm: false) }
                        .disabled(!armed)
                        .buttonStyle(.plain)
                        .font(.notch(11, weight: .medium))
                        .padding(.horizontal, 12)
                        .frame(height: 24)
                        .background(Capsule().fill(Theme.ink.opacity(0.1)))
                    Button("Confirm") { store.answerStart(launch, confirm: true) }
                        .disabled(!armed)
                        .buttonStyle(.plain)
                        .font(.notch(11, weight: .semibold))
                        .foregroundStyle(Theme.onAccent)
                        .padding(.horizontal, 12)
                        .frame(height: 24)
                        .background(Capsule().fill(Theme.accent.opacity(armed ? 1 : 0.4)))
                }
                .task(id: launch.questionId) {
                    armed = false
                    try? await Task.sleep(for: .milliseconds(600))
                    armed = true
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.ink.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(launch.state == .asking ? Theme.accent.opacity(0.5) : Theme.border))
    }

    private func screenText(_ screen: String) -> some View {
        Text(screen).font(.notch(10, design: .monospaced)).foregroundStyle(Theme.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.notch(11)).foregroundStyle(Theme.secondary)
    }
}

/// Offers its content at most `limit` points of height and takes only the height the content uses, where
/// `.frame(maxHeight:)` would take all of it.
private struct HeightLimit: Layout {
    let limit: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(ProposedViewSize(width: proposal.width, height: min(proposal.height ?? limit, limit))) ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}
