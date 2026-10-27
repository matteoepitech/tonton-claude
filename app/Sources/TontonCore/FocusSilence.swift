import Foundation

/// The alerts a Focus mode silences, from the Focus filter the user adds to it in System Settings › Focus. Each kind is
/// picked on its own, permission requests too: a Focus is the user saying not now, and the notch still shows who waits.
/// Silenced means no sound, notification, banner, open notch or webhook, as during quiet hours.
public struct FocusSilence: Equatable, Sendable {
    public enum Event: CaseIterable, Sendable {
        case finished
        /// A question, or an error that stopped Claude.
        case needsYou
        case permission
        case limitReset
        /// Budgets, achievements and the daily summary.
        case other

        public static func of(_ status: SessionStatus, finished: Bool) -> Event {
            if finished { return .finished }
            return status == .permission ? .permission : .needsYou
        }

        /// As it reads in a list: "Silences: finished tasks, permission requests".
        public var name: String {
            switch self {
            case .finished: String(core: "finished tasks")
            case .needsYou: String(core: "questions and errors")
            case .permission: String(core: "permission requests")
            case .limitReset: String(core: "usage limit resets")
            case .other: String(core: "budgets, achievements and the daily summary")
            }
        }
    }

    public let events: Set<Event>

    /// No Focus is on, or it has no filter for the app.
    public static let none = FocusSilence(events: [])

    public init(events: Set<Event>) {
        self.events = events
    }

    public func silences(_ event: Event) -> Bool { events.contains(event) }

    /// What the filter does, in its card in System Settings and in Settings › Notch.
    public var summary: String {
        switch events.count {
        case 0: return String(core: "Silences nothing")
        case Event.allCases.count: return String(core: "Silences every alert")
        default:
            // Commas only: some names have an "and" of their own.
            let kinds = Event.allCases.filter(events.contains).map(\.name).joined(separator: ", ")
            return String(core: "Silences: \(kinds)")
        }
    }
}
