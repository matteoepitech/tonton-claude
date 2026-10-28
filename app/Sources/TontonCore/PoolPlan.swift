import Foundation

// The plan the orchestrator proposes and an admin accepts (docs/pool-autopilot.md, The plan): its tasks, each with the
// machine it starts on once accepted, as a card with Accept in the notch. Mirrors shared/pool-plan.ts.

/// The plan the orchestrator proposed (`plan_propose`): its tasks in the order the control loop hands them out, each with
/// the machine it starts on as soon as an admin accepts it. Nil machine: later.
public struct PoolPlanProposal: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let id: String
        public let machine: PoolMachineRef?

        public init(id: String, machine: PoolMachineRef? = nil) {
            (self.id, self.machine) = (id, machine)
        }

        private enum Keys: String, CodingKey { case id, machine }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            id = try c.decode(String.self, forKey: .id)
            guard id.wholeMatch(of: #/[A-Za-z0-9_-]{1,64}/#) != nil else {
                throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "not a task id")
            }
            machine = try? c.decodeIfPresent(PoolMachineRef.self, forKey: .machine)
        }
    }

    /// Tasks a proposal names at most.
    public static let maxTasks = 100

    public let tasks: [Entry]

    public init(tasks: [Entry]) { self.tasks = tasks }

    private enum Keys: String, CodingKey { case tasks }
    /// Whatever an entry holds, to step over one of the wrong shape.
    private struct Skip: Decodable { init(from decoder: Decoder) {} }

    /// Entries of the wrong shape are dropped, the others kept.
    public init(from decoder: Decoder) throws {
        var list = try decoder.container(keyedBy: Keys.self).nestedUnkeyedContainer(forKey: .tasks)
        var tasks: [Entry] = []
        while !list.isAtEnd {
            if let entry = try? list.decode(Entry.self) {
                if tasks.count < Self.maxTasks { tasks.append(entry) }
            } else {
                _ = try? list.decode(Skip.self)
            }
        }
        self.tasks = tasks
    }
}

extension PoolState {
    static let planProposed = "plan_proposed"
    public static let planAccepted = "plan_accepted"
    /// Events after a proposal that say the work started.
    private static let started: Set<String> = [planAccepted, "dispatched", "dispatch_done"]

    /// The plan waiting for an admin: the orchestrator's latest proposal, as the relay attests its sender, while the
    /// dispatch is off and nothing since says the work started.
    public var pendingPlan: Post<PoolEventBody>? {
        guard dispatch?.on != true else { return nil }
        for event in events.reversed() {
            let kind = event.body?.kind ?? ""
            if Self.started.contains(kind) { return nil }
            guard kind == Self.planProposed, event.body?.proposal != nil, let lead = orchestrator,
                event.account == lead.account, event.session == lead.session
            else { continue }
            return event
        }
        return nil
    }

    /// One machine of the plan and the tasks it starts with, or the tasks that start later (nil machine).
    public struct PlanLane: Equatable, Identifiable, Sendable {
        public let machine: Machine?
        /// The machine's name, its member's, and what it brings: `Claude Max 20x`.
        public let name: String?
        public let owner: String?
        public let plan: String?
        public let capacity: Int?
        public var tasks: [Task]

        public var id: String { machine?.machine ?? "later" }
    }

    /// The proposal as the card shows it: each machine with what it starts, then what comes later.
    public func planLanes(_ proposal: PoolPlanProposal) -> [PlanLane] {
        var lanes: [PlanLane] = []
        var later: [Task] = []
        for entry in proposal.tasks {
            guard let item = tasks.first(where: { $0.id == entry.id }), item.task != nil else { continue }
            guard let ref = entry.machine, let machine = machines?.first(where: { $0.machine == ref.machine && $0.account == ref.account })
            else {
                later.append(item)
                continue
            }
            if let index = lanes.firstIndex(where: { $0.machine?.machine == machine.machine }) {
                lanes[index].tasks.append(item)
            } else {
                lanes.append(
                    PlanLane(
                        machine: machine, name: machine.profile?.name,
                        owner: members.first { $0.account == machine.account }?.profile?.name, plan: machine.profile?.planLabel,
                        capacity: machine.profile?.capacity, tasks: [item]))
            }
        }
        if !later.isEmpty { lanes.append(PlanLane(machine: nil, name: nil, owner: nil, plan: nil, capacity: nil, tasks: later)) }
        return lanes
    }
}
