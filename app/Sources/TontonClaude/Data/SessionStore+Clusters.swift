import Foundation
import TontonCore

/// Which sessions can be put in a cluster: one its agent sends to the relay, from an agent that knows clusters
/// (docs/cluster.md, Versions). An older agent would ignore the order, so the notch does not offer it.
extension SessionStore {
    /// Nil when the session can be put in a cluster, otherwise why not, as the notch says it.
    func whyNotCluster(_ session: SessionSummary) -> String? {
        guard connection == .connected else { return String(localized: "Connect to the relay to put a session in a cluster.") }
        guard isRelaySession(session.id) else {
            return String(localized: "Only sessions an agent serves can be in a cluster: this one is read from this Mac's files.")
        }
        if let machine = machines.first(where: { $0.id == session.machineId }), !machine.joinsClusters {
            return String(localized: "The agent on \(machine.name) is too old for clusters. Update agent first.")
        }
        guard session.agentOnline else { return String(localized: "Its agent is offline.") }
        return nil
    }

    /// The account's own sessions an agent serves, for the roster's Put in.
    var clusterCandidates: [SessionSummary] { sessions.filter { isRelaySession($0.id) && whyNotCluster($0) == nil } }
}
