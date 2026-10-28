import SwiftUI
import TontonCore

/// Puts one of the account's machines in a pool for the autopilot (docs/pool-autopilot.md), in one click: how it works
/// there comes from what its agent reports (its Claude plan, its tools, its memory). The owner only says whether its
/// sessions may run commands without asking, and can still change the rest under Customize.
struct AddToPoolView: View {
    let machine: MachineInfo
    let close: () -> Void
    @ObservedObject private var pools = PoolStore.shared
    @State private var poolId: String?
    @State private var full = false
    /// Set once the owner opens Customize: the form, filled in with the automatic profile.
    @State private var custom: PoolMachineForm?
    @State private var areas = ""
    @State private var error: String?

    private var pool: String? { poolId ?? pools.joinable.first?.id }
    private var automatic: PoolMachineProfile? {
        pool.flatMap { pools.automaticProfile(of: machine, pool: $0, mode: full ? .full : .edits) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                IconTile(systemName: "cpu", tint: Theme.accent, size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Add \(machine.name) to a pool").font(.system(size: 15, weight: .semibold))
                    Text("It starts a session for each task the pool gives it, and ends it when the task is done.")
                        .font(.system(size: 12)).foregroundStyle(Theme.textDim).fixedSize(horizontal: false, vertical: true)
                }
            }
            if pools.joinable.isEmpty {
                Text(pools.problem ?? String(localized: "This account is in no pool yet. Make one or join one on the relay's website."))
                    .font(.system(size: 12)).foregroundStyle(Theme.textDim)
            } else {
                if pools.joinable.count > 1 {
                    Picker(
                        "Pool",
                        selection: Binding(
                            get: { pool },
                            set: {
                                poolId = $0; custom = nil
                            })
                    ) {
                        ForEach(pools.joinable, id: \.id) { board in Text(board.name).tag(Optional(board.id)) }
                    }
                    .pickerStyle(.menu)
                    .fixedSize()
                } else if let board = pools.joinable.first {
                    Label(board.name, systemImage: "person.3.fill").font(.system(size: 12.5, weight: .medium)).foregroundStyle(Theme.text)
                }
                if let custom {
                    customize(custom)
                } else if let profile = automatic {
                    summary(profile)
                } else {
                    Text("No coding tool on this machine: install Claude Code or OpenCode there first.")
                        .font(.system(size: 12)).foregroundStyle(Theme.danger)
                }
                Toggle(isOn: $full) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Run commands without asking").font(.system(size: 12.5, weight: .medium))
                        Text(full ? PoolMachineMode.full.detail : PoolMachineMode.edits.detail)
                            .font(.system(size: 11.5))
                            .foregroundStyle(full ? Theme.danger : Theme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .toggleStyle(AccentToggleStyle())
                .onChange(of: full) { _, full in custom?.mode = full ? .full : .edits }
            }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger) }
            HStack {
                if custom == nil, let profile = automatic {
                    Button("Customize…") {
                        custom = PoolMachineForm(profile)
                        areas = profile.areas?.joined(separator: ", ") ?? ""
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textDim)
                }
                Spacer()
                Button("Cancel", action: close).keyboardShortcut(.cancelAction).buttonStyle(ThemeButtonStyle())
                Button("Add to pool", action: add)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(ThemeButtonStyle(primary: true))
                    .disabled(pools.joinable.isEmpty || (custom.map { $0.problem != nil } ?? (automatic == nil)))
            }
        }
        .padding(20)
        .frame(width: 460)
        .background(Theme.bg)
        .task { await pools.refresh() }
    }

    /// What the machine brings, worked out from its agent's report.
    private func summary(_ profile: PoolMachineProfile) -> some View {
        Card(padding: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(verbatim: profile.planLabel).font(.system(size: 13, weight: .semibold))
                    Text("\(profile.capacity) sessions at once").font(.system(size: 12)).foregroundStyle(Theme.textDim)
                }
                Text(verbatim: profile.workdir).font(Theme.mono).foregroundStyle(Theme.textDim).lineLimit(1).truncationMode(.middle)
                Text("Found on the machine: nothing to fill in.").font(.system(size: 11)).foregroundStyle(Theme.textFaint)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Everything the profile says, for an owner who wants another folder, more sessions or other models.
    private func customize(_ form: PoolMachineForm) -> some View {
        let binding = Binding(get: { custom ?? form }, set: { custom = $0 })
        return Form {
            Picker("Runs", selection: binding.tool) {
                ForEach(CodingTool.allCases, id: \.self) { tool in Text(tool.label).tag(tool) }
            }
            .onChange(of: binding.wrappedValue.tool) { _, tool in custom?.takes = .default(for: tool) }
            Stepper(value: binding.capacity, in: PoolMachineProfile.capacities) {
                Text("\(binding.wrappedValue.capacity) sessions at once")
            }
            TextField("Work folder", text: binding.workdir, prompt: Text(verbatim: "~/tonton-pools/…"))
            Picker("Takes", selection: binding.takes) {
                ForEach(PoolTaskSize.allCases) { size in Text(size.label).tag(size) }
            }
            TextField("Areas", text: $areas, prompt: Text("front, back… (optional)"))
            models(binding)
        }
        .formStyle(.grouped)
        .frame(maxHeight: 360)
    }

    /// Each task runs on the least costly tier that can do it: the owner allows tiers, names their models, or locks one.
    private func models(_ form: Binding<PoolMachineForm>) -> some View {
        Section {
            Picker("Every task runs on", selection: form.lock) {
                Text("The tier it needs").tag(PoolModelTier?.none)
                ForEach(PoolModelTier.allCases) { tier in Text(tier.label).tag(Optional(tier)) }
            }
            ForEach(PoolModelTier.allCases) { tier in
                HStack {
                    Toggle(tier.label, isOn: allows(tier, in: form)).disabled(form.wrappedValue.lock != nil)
                    TextField("Model", text: model(of: tier, in: form), prompt: Text(verbatim: tier.defaultModel))
                        .labelsHidden()
                        .frame(width: 150)
                }
            }
            Picker("After a session fails a task", selection: form.escalations) {
                Text("Stay on the same tier").tag(0)
                Text("Climb one tier").tag(1)
                Text("Climb up to two tiers").tag(2)
            }
            .disabled(form.wrappedValue.lock != nil)
            Group {
                switch form.wrappedValue.problem {
                case .tiers: Text("Allow at least one tier.").foregroundStyle(Theme.danger)
                case .model: Text("Not a model name: use an alias, a model id or provider/model.").foregroundStyle(Theme.danger)
                default: Text("A Claude Code alias or model id, or an OpenCode provider/model. Empty: its default model.")
                }
            }
            .font(.system(size: 11.5))
            .foregroundStyle(Theme.textDim)
            .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text("Models")
        }
    }

    private func allows(_ tier: PoolModelTier, in form: Binding<PoolMachineForm>) -> Binding<Bool> {
        Binding(
            get: { form.wrappedValue.allowed.contains(tier) },
            set: {
                form.wrappedValue.allowed = $0 ? form.wrappedValue.allowed.union([tier]) : form.wrappedValue.allowed.subtracting([tier])
            })
    }

    private func model(of tier: PoolModelTier, in form: Binding<PoolMachineForm>) -> Binding<String> {
        Binding(get: { form.wrappedValue.models[tier] ?? "" }, set: { form.wrappedValue.models[tier] = $0 })
    }

    private func add() {
        guard let pool else { return }
        do {
            if var filled = custom {
                filled.areas = [areas]
                try pools.addMachine(machine, pool: pool, form: filled)
            } else if let profile = automatic {
                try pools.addMachine(machine, pool: pool, profile: profile)
            }
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
        // `Claude Max 20x`, `OpenCode`: what it brings, as its agent reported it.
        let tool = profile.planLabel
        return String(localized: "\(tool) · \(profile.capacity) at once · \(profile.mode.label)")
    }
}
