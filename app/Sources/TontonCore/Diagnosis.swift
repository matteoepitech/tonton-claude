import Foundation

/// How a machine is set up (shared/protocol.ts `Diagnosis`), once decrypted: the checks its agent ran, and what the
/// repair the app asked for did.
public struct Diagnosis: MachineAnswer {
    /// One line: the agent names it and writes its text, so checks from a newer agent show too.
    public struct Check: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let ok: Bool
        public let detail: String
        /// A repair the app can ask for: it redoes that part of the install step on the machine.
        public let fix: String?

        public init(id: String, label: String, ok: Bool, detail: String, fix: String? = nil) {
            (self.id, self.label, self.ok, self.detail, self.fix) = (id, label, ok, detail, fix)
        }
    }

    public struct Repair: Codable, Equatable, Sendable {
        public let fix: String
        public let ok: Bool
        public let text: String

        public init(fix: String, ok: Bool, text: String) {
            (self.fix, self.ok, self.text) = (fix, ok, text)
        }
    }

    public let requestId: String
    public let machineId: String
    public let at: String
    /// The agent installed on the machine.
    public let version: String
    public let checks: [Check]
    public let fixed: Repair?
    /// Why the agent ran no check.
    public let error: String?

    public init(
        requestId: String, machineId: String, at: String, version: String, checks: [Check], fixed: Repair? = nil, error: String? = nil
    ) {
        (self.requestId, self.machineId, self.at, self.version) = (requestId, machineId, at, version)
        (self.checks, self.fixed, self.error) = (checks, fixed, error)
    }

    public var checkedAt: Date? { ISO8601.parse(at) }

    /// The checks that need something, first.
    public var failing: [Check] { checks.filter { !$0.ok } }
}

/// A request for a machine's diagnosis, with the repair it carries if any.
public typealias DiagnosisRequest = MachineRequest<Diagnosis>
