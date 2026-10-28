import Foundation

// Pool machines (docs/pool-autopilot.md): members put whole machines in a pool, and each machine's agent service starts
// the sessions for the tasks dispatched to it. Mirrors shared/pool-machines.ts. The profile is sealed with the pool key
// for the members; the order, sealed with the account key, is what the machine's agent applies, so neither the pool nor
// the relay can change the folder it works in or widen what its sessions may do.

/// What the sessions a pool machine starts may do without asking. The machine owner's choice, never the pool's.
public enum PoolMachineMode: String, Codable, CaseIterable, Sendable, Identifiable {
    /// Every permission prompt goes to the machine owner, as for any session.
    case ask
    /// File edits and read-only tools pass, the rest asks.
    case edits
    /// Everything passes: only for a machine or a VM given to the work.
    case full

    public var id: String { rawValue }
}

/// A whole machine in a pool, as the members see it, sealed with the pool key.
public struct PoolMachineProfile: Codable, Equatable, Sendable {
    /// How many sessions a machine runs at once for one pool.
    public static let capacities = 1...8

    public var name: String?
    /// `claude` or `opencode`.
    public var tool: String
    public var capacity: Int
    /// The folder on the machine the pool's work goes in: the repository, and a git worktree per task.
    public var workdir: String
    public var mode: PoolMachineMode
    /// `simple` or `large`. Nil: by its tool.
    public var takes: String?
    /// The areas it prefers.
    public var areas: [String]?
    /// Which models its sessions run on. Nil: each task gets the tier it needs.
    public var models: PoolModelPolicy?

    public init(
        name: String? = nil, tool: String, capacity: Int, workdir: String, mode: PoolMachineMode, takes: String? = nil,
        areas: [String]? = nil, models: PoolModelPolicy? = nil
    ) {
        (self.name, self.tool, self.capacity, self.workdir, self.mode) = (name, tool, capacity, workdir, mode)
        (self.takes, self.areas, self.models) = (takes, areas, models)
    }

    private enum Keys: String, CodingKey { case name, tool, capacity, workdir, mode, takes, areas, models }

    /// What another member sealed is checked as the agent would: a profile it could not run reads as none.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        tool = try c.decode(String.self, forKey: .tool)
        capacity = try c.decode(Int.self, forKey: .capacity)
        workdir = try c.decode(String.self, forKey: .workdir)
        mode = try c.decode(PoolMachineMode.self, forKey: .mode)
        guard ["claude", "opencode"].contains(tool), Self.capacities.contains(capacity), Self.isWorkdir(workdir) else {
            throw DecodingError.dataCorruptedError(forKey: .workdir, in: c, debugDescription: "not a profile an agent runs")
        }
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        takes = (try? c.decodeIfPresent(String.self, forKey: .takes)).flatMap { ["simple", "large"].contains($0) ? $0 : nil }
        areas = (try? c.decodeIfPresent([String].self, forKey: .areas)).map { $0.filter { !$0.isEmpty } }.flatMap { $0.isEmpty ? nil : $0 }
        models = try? c.decodeIfPresent(PoolModelPolicy.self, forKey: .models)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encode(tool, forKey: .tool)
        try c.encode(capacity, forKey: .capacity)
        try c.encode(workdir, forKey: .workdir)
        try c.encode(mode, forKey: .mode)
        try c.encodeIfPresent(takes, forKey: .takes)
        try c.encodeIfPresent(areas, forKey: .areas)
        try c.encodeIfPresent(models, forKey: .models)
    }

    /// `/srv/pool`, `~/pool`, `C:\pool`: a folder from the root or the home folder, never relative, never climbing out.
    public static func isWorkdir(_ path: String) -> Bool {
        guard path.count <= 1024, path.wholeMatch(of: #/(\/|~\/|[A-Za-z]:[\\\/]).+/#) != nil else { return false }
        let parts = path.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        return !parts.contains("..") && !path.contains(where: { $0 == "\0" || $0 == "\n" || $0 == "\r" })
    }
}

/// The machine owner's choice of models for the pool's tasks (shared/pool-model.ts): tiers are `light`, `balanced` and
/// `strong`. The agent checks it; the app keeps it as it is, so that a profile it writes back still says so.
public struct PoolModelPolicy: Codable, Equatable, Sendable {
    /// Every task runs on this tier, whatever it is.
    public var lock: String?
    /// The tiers its sessions may use. Nil: all three.
    public var allowed: [String]?
    /// The model each tier stands for: a Claude Code alias or id, an OpenCode `provider/model`.
    public var tiers: [String: String]?
    /// How many tiers a task may climb after sessions failed it.
    public var escalations: Int?

    public init(lock: String? = nil, allowed: [String]? = nil, tiers: [String: String]? = nil, escalations: Int? = nil) {
        (self.lock, self.allowed, self.tiers, self.escalations) = (lock, allowed, tiers, escalations)
    }
}

/// What the owner fills in to put one of its machines in a pool (Settings › Machines › Add to pool…).
public struct PoolMachineForm: Equatable, Sendable {
    public enum Problem: Equatable, Sendable {
        case capacity, workdir
    }

    public var tool: CodingTool
    public var capacity: Int
    public var workdir: String
    public var mode: PoolMachineMode
    public var takes: PoolTaskSize
    /// Typed by the owner, comma separated or one per entry.
    public var areas: [String]

    /// One session at a time, asking for everything: what a machine runs until its owner says otherwise.
    public init(tool: CodingTool = .claudeCode, workdir: String = "~/tonton-pool") {
        self.tool = tool
        capacity = 1
        self.workdir = workdir
        mode = .ask
        takes = .default(for: tool)
        areas = []
    }

    /// Why it can't be sent yet, or nil.
    public var problem: Problem? {
        if !PoolMachineProfile.capacities.contains(capacity) { return .capacity }
        if !PoolMachineProfile.isWorkdir(workdir.trimmingCharacters(in: .whitespacesAndNewlines)) { return .workdir }
        return nil
    }

    /// The profile, named after the machine, or nil while there is a problem.
    public func profile(name: String?) -> PoolMachineProfile? {
        guard problem == nil else { return nil }
        let cleaned = areas.flatMap { $0.split(separator: ",") }.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        var seen = Set<String>()
        let unique = cleaned.filter { !$0.isEmpty && seen.insert($0).inserted }
        return PoolMachineProfile(
            name: name, tool: tool == .openCode ? "opencode" : "claude", capacity: capacity,
            workdir: workdir.trimmingCharacters(in: .whitespacesAndNewlines), mode: mode, takes: takes.rawValue,
            areas: unique.isEmpty ? nil : Array(unique.prefix(20)))
    }
}

/// From the machine owner's app to that machine's agent service: work for this pool, with its key, this way.
struct PoolMachineOrder: Codable, Equatable {
    let poolId: String
    let machineId: String
    let key: String
    let version: Int
    let issuedAt: String
    let profile: PoolMachineProfile
}

extension SessionVault {
    /// Puts one of the account's machines in a pool: its agent takes it only if it opens with the account key and names
    /// that machine and that pool.
    public func sealPoolMachineOrder(
        poolId: String, machineId: String, key poolKey: String, version: Int, profile: PoolMachineProfile, issuedAt: Date = Date()
    ) throws -> String {
        let order = PoolMachineOrder(
            poolId: poolId, machineId: machineId, key: poolKey, version: version, issuedAt: ISO8601DateFormatter().string(from: issuedAt),
            profile: profile)
        return try E2E.seal(order, with: key)
    }
}

/// A pool machine, by its owner's account and its id.
public struct PoolMachineRef: Codable, Equatable, Hashable, Sendable {
    public let account: String
    public let machine: String

    public init(account: String, machine: String) {
        (self.account, self.machine) = (account, machine)
    }
}

/// A pool machine as the relay sends it.
public struct PoolMachineWire: Codable, Equatable, Sendable {
    public let account: String
    public let machine: String
    public let addedAt: String
    /// `PoolMachineProfile`, sealed with the pool key.
    public let profile: String?
    /// Connected to the relay, as Settings › Machines shows it.
    public let online: Bool
    /// Its agent service took the order. Online but never ready: its agent is older.
    public let ready: Bool
    /// Its owner or an admin stopped it: it takes no work until one of them starts it again. Nil: it works.
    public var stopped: Bool? = nil
}

/// Whether the pool's control loop hands out tasks, sealed with the pool key.
public struct PoolDispatch: Codable, Equatable, Sendable {
    public var on: Bool
    public var note: String?

    public init(on: Bool, note: String? = nil) {
        self.on = on
        self.note = note
    }
}

extension MachineInfo {
    /// Agents from this version run pool machines; older ones ignore the order.
    public static let poolMachinesSince = "0.9.0"

    public var runsPoolMachines: Bool { runs(atLeast: Self.poolMachinesSince) }
}

extension PoolMachineMode {
    /// As Settings › Machines › Add to pool… offers it.
    public var label: String {
        switch self {
        case .ask: String(core: "Ask for everything")
        case .edits: String(core: "File edits pass")
        case .full: String(core: "Everything passes")
        }
    }

    public var detail: String {
        switch self {
        case .ask: String(core: "Every permission request of its pool sessions comes to you, as for any session.")
        case .edits: String(core: "Its pool sessions edit files and read without asking. Commands and the rest still ask you.")
        case .full:
            String(
                core: """
                    Its pool sessions do anything without asking, commands included: only for a machine or a virtual machine you \
                    give to the work, never one with your own files on it.
                    """)
        }
    }
}

extension PoolState {
    /// What a pool machine runs now: the tasks dispatched to it that are not done yet, the session in each slot.
    public func slots(of machine: PoolMachineRef) -> [Task] {
        tasks.filter { item in
            guard let task = item.task, task.machine == machine else { return false }
            return task.state == .assigned || task.state == .inProgress || task.state == .blocked
        }
    }
}

extension PoolTaskState {
    /// As a pool machine's slot shows it.
    public var label: String {
        switch self {
        case .todo: String(core: "to do")
        case .assigned: String(core: "assigned")
        case .inProgress: String(core: "in progress")
        case .review: String(core: "in review")
        case .done: String(core: "finished")
        case .blocked: String(core: "blocked")
        }
    }
}
