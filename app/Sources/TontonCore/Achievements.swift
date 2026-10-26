import Foundation

/// Badges earned by using Tonton Claude, unlocked once and kept.
public enum Achievement: String, CaseIterable, Codable, Sendable {
    case firstSession, approved10, approved100, threeMachines, fiveAtOnce, marathon, deepWork, nightOwl, remoteControl

    public var title: String {
        switch self {
        case .firstSession: "Hello, Tonton"
        case .approved10: "Rubber stamp"
        case .approved100: "Trusted operator"
        case .threeMachines: "Fleet commander"
        case .fiveAtOnce: "Juggler"
        case .marathon: "Marathon"
        case .deepWork: "Deep work"
        case .nightOwl: "Night owl"
        case .remoteControl: "Remote control"
        }
    }

    public var detail: String {
        switch self {
        case .firstSession: "A first session showed up in the notch."
        case .approved10: "10 permissions approved."
        case .approved100: "100 permissions approved."
        case .threeMachines: "Sessions on 3 machines at once."
        case .fiveAtOnce: "5 sessions working at the same time."
        case .marathon: "A session open for 6 hours."
        case .deepWork: "Claude worked 30 minutes on a single turn."
        case .nightOwl: "Claude at work between 2 and 5 in the morning."
        case .remoteControl: "50 messages sent from the notch."
        }
    }

    /// An SF Symbol.
    public var symbol: String {
        switch self {
        case .firstSession: "sparkles"
        case .approved10: "checkmark.seal"
        case .approved100: "checkmark.seal.fill"
        case .threeMachines: "desktopcomputer"
        case .fiveAtOnce: "circle.grid.3x3.fill"
        case .marathon: "figure.run"
        case .deepWork: "brain.head.profile"
        case .nightOwl: "moon.stars.fill"
        case .remoteControl: "antenna.radiowaves.left.and.right"
        }
    }
}

/// What counts towards the achievements, saved between launches.
public struct AchievementProgress: Codable, Equatable, Sendable {
    public private(set) var unlocked: Set<Achievement> = []
    public private(set) var approvals = 0
    public private(set) var notchMessages = 0
    /// When each session started its current turn. Not saved: a turn does not survive a restart of the app.
    private var workingSince: [String: Date] = [:]

    enum CodingKeys: String, CodingKey { case unlocked, approvals, notchMessages }

    public init() {}

    /// The newly unlocked ones, in the order of `Achievement.allCases`.
    public mutating func sessionsChanged(_ sessions: [SessionSummary], now: Date = Date(), calendar: Calendar = .current) -> [Achievement] {
        var earned: Set<Achievement> = []
        let live = sessions.filter(\.status.isLive)
        if !sessions.isEmpty { earned.insert(.firstSession) }
        if Set(live.map(\.machineId)).count >= 3 { earned.insert(.threeMachines) }
        let working = live.filter { $0.status == .working }
        if working.count >= 5 { earned.insert(.fiveAtOnce) }
        if live.contains(where: { now.timeIntervalSince($0.startedAt) >= 6 * 3600 }) { earned.insert(.marathon) }
        if !working.isEmpty, (2..<5).contains(calendar.component(.hour, from: now)) { earned.insert(.nightOwl) }

        for session in sessions {
            if session.status == .working {
                let since = workingSince[session.id] ?? now
                workingSince[session.id] = since
                if now.timeIntervalSince(since) >= 30 * 60 { earned.insert(.deepWork) }
            } else if session.status == .idle || !session.status.isLive {
                workingSince[session.id] = nil
            }
        }
        let listed = Set(sessions.map(\.id))
        workingSince = workingSince.filter { listed.contains($0.key) }
        return unlock(earned)
    }

    public mutating func approved() -> [Achievement] {
        approvals += 1
        return unlock(approvals >= 100 ? [.approved10, .approved100] : approvals >= 10 ? [.approved10] : [])
    }

    public mutating func sentFromNotch() -> [Achievement] {
        notchMessages += 1
        return unlock(notchMessages >= 50 ? [.remoteControl] : [])
    }

    private mutating func unlock(_ earned: Set<Achievement>) -> [Achievement] {
        let new = Achievement.allCases.filter { earned.contains($0) && !unlocked.contains($0) }
        unlocked.formUnion(new)
        return new
    }
}
