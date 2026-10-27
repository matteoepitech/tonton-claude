import Foundation
import TontonCore

/// Which sessions can work in a pool (#219): one its agent sends to the relay, from an agent that knows pools.
extension SessionStore {
    /// Nil when the session can join a pool, otherwise why not, as the notch says it.
    func whyNotPool(_ session: SessionSummary) -> String? {
        guard connection == .connected else { return String(localized: "Connect to the relay to put a session in a pool.") }
        guard isRelaySession(session.id) else {
            return String(localized: "Only sessions an agent serves can join a pool: this one is read from this Mac's files.")
        }
        if let machine = machines.first(where: { $0.id == session.machineId }), !machine.joinsPools {
            return String(localized: "The agent on \(machine.name) is too old for pools. Update agent first.")
        }
        guard session.agentOnline else { return String(localized: "Its agent is offline.") }
        return nil
    }
}
