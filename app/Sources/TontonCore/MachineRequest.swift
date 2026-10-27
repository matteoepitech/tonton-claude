import Foundation

/// What a machine sends back for a request of the app, sealed: it names the request and the machine.
public protocol MachineAnswer: Codable, Equatable, Sendable {
    var requestId: String { get }
    var machineId: String { get }
    /// Why the machine could not do what was asked.
    var error: String? { get }
}

/// A request from the app to one machine (its agent log, a diagnosis), from the click in Settings › Machines to the
/// answer.
public struct MachineRequest<Answer: MachineAnswer>: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case loading
        case loaded(Answer)
        case failed(String)
    }

    public let id: String
    public let machineId: String
    public let state: State
    /// The answer shown before this request, kept on screen while it loads.
    public let previous: Answer?

    public init(id: String = SessionLaunch.newId(), machineId: String, state: State = .loading, previous: Answer? = nil) {
        (self.id, self.machineId, self.state, self.previous) = (id, machineId, state, previous)
    }

    /// The request once the relay answered. Only an answer sealed for this request and this machine counts: the relay
    /// could hand back an older one, or another machine's.
    public func received(reason: String?, answer: Answer?, machine: String) -> MachineRequest {
        guard state == .loading else { return self }
        if reason == "offline" { return failed("\(machine) is offline. Check that it is on and that the Tonton Claude agent runs there.") }
        guard let answer, answer.requestId == id, answer.machineId == machineId else { return self }
        if let error = answer.error { return failed(error) }
        return MachineRequest(id: id, machineId: machineId, state: .loaded(answer), previous: previous)
    }

    public func failed(_ text: String) -> MachineRequest {
        MachineRequest(id: id, machineId: machineId, state: .failed(text), previous: previous)
    }

    /// What to show: this request's answer, or the previous one until it comes.
    public var answer: Answer? {
        if case .loaded(let answer) = state { return answer }
        return previous
    }

    public var isLoading: Bool { state == .loading }
}
