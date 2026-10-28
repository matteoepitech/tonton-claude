import SwiftUI
import TontonCore

/// Puts one of the account's machines in a pool for the autopilot (docs/pool-autopilot.md): the pool, what its sessions
/// run, how many at once, where the work goes, and what they may do without asking. `full` says plainly what it means.
struct AddToPoolView: View {
    let machine: MachineInfo
    let close: () -> Void
    @ObservedObject private var pools = PoolStore.shared
    @State private var poolId: String?
    @State private var form = PoolMachineForm()
    @State private var areas = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add \(machine.name) to a pool").font(.system(size: 15, weight: .semibold))
            Text("Its agent starts a session for each task the pool gives it, in a folder of its own, and ends it when the task is done.")
                .font(.system(size: 12)).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
            if pools.joinable.isEmpty {
                Text(pools.problem ?? String(localized: "This account is in no pool yet. Make one or join one on the relay's website."))
                    .font(.system(size: 12)).foregroundStyle(Theme.textDim)
            } else {
                Form {
                    Picker("Pool", selection: Binding(get: { poolId ?? pools.joinable.first?.id }, set: { poolId = $0 })) {
                        ForEach(pools.joinable, id: \.id) { board in Text(board.name).tag(Optional(board.id)) }
                    }
                    Picker("Runs", selection: $form.tool) {
                        ForEach(CodingTool.allCases, id: \.self) { tool in Text(tool.label).tag(tool) }
                    }
                    .onChange(of: form.tool) { _, tool in form.takes = .default(for: tool) }
                    Stepper(value: $form.capacity, in: PoolMachineProfile.capacities) {
                        Text("\(form.capacity) sessions at once")
                    }
                    TextField("Work folder", text: $form.workdir, prompt: Text(verbatim: "~/tonton-pool"))
                    Picker("Takes", selection: $form.takes) {
                        ForEach(PoolTaskSize.allCases) { size in Text(size.label).tag(size) }
                    }
                    TextField("Areas", text: $areas, prompt: Text("front, back… (optional)"))
                    Picker("Without asking", selection: $form.mode) {
                        ForEach(PoolMachineMode.allCases) { mode in Text(mode.label).tag(mode) }
                    }
                    Text(form.mode.detail)
                        .font(.system(size: 11.5))
                        .foregroundStyle(form.mode == .full ? Theme.danger : Theme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .formStyle(.grouped)
            }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger) }
            HStack {
                Spacer()
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                Button("Add to pool", action: add)
                    .keyboardShortcut(.defaultAction)
                    .disabled(pools.joinable.isEmpty || form.problem != nil)
            }
        }
        .padding(20)
        .frame(width: 460)
        .task { await pools.refresh() }
    }

    private func add() {
        guard let pool = poolId ?? pools.joinable.first?.id else { return }
        var filled = form
        filled.areas = [areas]
        do {
            try pools.addMachine(machine, pool: pool, form: filled)
            close()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The pools a machine of the account is in: how it runs there, what it runs now, and taking it out.
struct MachinePools: View {
    let machine: MachineInfo
    @ObservedObject private var pools = PoolStore.shared

    var body: some View {
        let memberships = pools.memberships(of: machine.id)
        if !memberships.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(memberships, id: \.board.id) { membership in
                    row(membership.board, membership.machine, membership.slots)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
    }

    private func row(_ board: PoolBoard, _ entry: PoolState.Machine, _ slots: [PoolState.Task]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "person.3.sequence").font(.system(size: 11)).foregroundStyle(Theme.accent)
                Text(board.name).font(.system(size: 12, weight: .medium))
                Text(summary(entry)).font(.system(size: 11.5)).foregroundStyle(Theme.textDim).lineLimit(1)
                Spacer()
                if entry.stopped {
                    Button("Start") { pools.stopMachine(machine.id, stopped: false, pool: board.id) }
                        .buttonStyle(ThemeButtonStyle())
                        .help("It takes the pool's tasks again.")
                } else {
                    Button("Stop") { pools.stopMachine(machine.id, stopped: true, pool: board.id) }
                        .buttonStyle(ThemeButtonStyle())
                        .help("Its pool sessions end, and their tasks go back to the board. It takes no tasks until you start it again.")
                }
                Button("Remove") { pools.removeMachine(machine.id, pool: board.id) }
                    .buttonStyle(ThemeButtonStyle())
                    .help("Its pool sessions end, and it leaves the pool.")
            }
            if entry.stopped {
                Text("Stopped: it takes no tasks until you start it again.").font(.system(size: 11.5)).foregroundStyle(Theme.textDim)
            } else if !entry.ready && entry.online {
                Text("Its agent has not taken the order: update the agent to \(MachineInfo.poolMachinesSince) or later.")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.warning)
            }
            ForEach(slots) { slot in
                Text(verbatim: "· \(slot.task?.title ?? "")  \(slot.task?.state.label ?? "")")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.textDim).lineLimit(1)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.ink.opacity(0.04)))
    }

    private func summary(_ entry: PoolState.Machine) -> String {
        guard let profile = entry.profile else { return "" }
        let tool = profile.tool == "opencode" ? CodingTool.openCode.label : CodingTool.claudeCode.label
        return String(localized: "\(tool) · \(profile.capacity) at once · \(profile.mode.label)")
    }
}
