import Foundation

/// Badges earned by using Tonton Claude, unlocked once and kept.
public enum Achievement: String, CaseIterable, Codable, Sendable {
    case firstSession, approved10, approved100, threeMachines, fiveAtOnce, marathon, deepWork, nightOwl, remoteControl
    case weekStreak, toolCalls1000, everyPlatform

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
        case .weekStreak: "On a roll"
        case .toolCalls1000: "Toolsmith"
        case .everyPlatform: "Cross-platform"
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
        case .weekStreak: "Claude worked 7 days in a row."
        case .toolCalls1000: "1,000 tool calls in the conversations."
        case .everyPlatform: "Sessions on macOS, Windows and Linux."
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
        case .weekStreak: "flame.fill"
        case .toolCalls1000: "hammer.fill"
        case .everyPlatform: "square.stack.3d.up.fill"
        }
    }
}

/// How far a locked achievement is, for the ones that count something.
public struct AchievementGoal: Equatable, Sendable {
    public let done: Int
    public let target: Int

    init(_ done: Int, of target: Int) {
        self.done = min(done, target)
        self.target = target
    }

    public var fraction: Double { Double(done) / Double(target) }
}

/// What counts towards the achievements, saved between launches.
public struct AchievementProgress: Codable, Equatable, Sendable {
    public private(set) var unlocked: Set<Achievement> = []
    public private(set) var approvals = 0
    public private(set) var notchMessages = 0
    /// The last days Claude worked, `2026-10-26`, oldest first.
    public private(set) var activeDays: [String] = []
    /// `darwin`, `win32` and `linux`, as agents name them.
    public private(set) var platforms: Set<String> = []
    public private(set) var toolCalls = 0
    /// The calls already counted, by tool use id. Dropped once the badge is unlocked: they only matter until then.
    private var countedCalls: Set<String> = []
    /// When each session started its current turn. Not saved: a turn does not survive a restart of the app.
    private var workingSince: [String: Date] = [:]

    static let streakDays = 7
    static let toolCallGoal = 1000
    static let allPlatforms: Set = ["darwin", "win32", "linux"]

    enum CodingKeys: String, CodingKey { case unlocked, approvals, notchMessages, activeDays, platforms, toolCalls, countedCalls }

    public init() {}

    /// Missing fields start at zero, so progress saved by an older version is kept. Achievements this version doesn't
    /// know, from a newer one, are skipped rather than losing the others.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let names = try container.decodeIfPresent([String].self, forKey: .unlocked) ?? []
        unlocked = Set(names.compactMap(Achievement.init(rawValue:)))
        approvals = try container.decodeIfPresent(Int.self, forKey: .approvals) ?? 0
        notchMessages = try container.decodeIfPresent(Int.self, forKey: .notchMessages) ?? 0
        activeDays = try container.decodeIfPresent([String].self, forKey: .activeDays) ?? []
        platforms = try container.decodeIfPresent(Set<String>.self, forKey: .platforms) ?? []
        toolCalls = try container.decodeIfPresent(Int.self, forKey: .toolCalls) ?? 0
        countedCalls = try container.decodeIfPresent(Set<String>.self, forKey: .countedCalls) ?? []
    }

    /// Progress towards a locked achievement that counts something, nil for the others and once it is unlocked.
    public func goal(_ achievement: Achievement, now: Date = Date(), calendar: Calendar = .current) -> AchievementGoal? {
        guard !unlocked.contains(achievement) else { return nil }
        switch achievement {
        case .approved10: return AchievementGoal(approvals, of: 10)
        case .approved100: return AchievementGoal(approvals, of: 100)
        case .remoteControl: return AchievementGoal(notchMessages, of: 50)
        case .weekStreak: return AchievementGoal(streak(now: now, calendar: calendar), of: Self.streakDays)
        case .toolCalls1000: return AchievementGoal(toolCalls, of: Self.toolCallGoal)
        case .everyPlatform: return AchievementGoal(platforms.count, of: Self.allPlatforms.count)
        default: return nil
        }
    }

    /// Days in a row Claude worked, up to today. A streak that reached yesterday still runs until today ends.
    func streak(now: Date, calendar: Calendar) -> Int {
        let days = Set(activeDays)
        let today = calendar.startOfDay(for: now)
        let start = days.contains(UsageHistory.day(today, calendar: calendar)) ? 0 : 1
        var count = 0
        while let day = calendar.date(byAdding: .day, value: -(start + count), to: today),
            days.contains(UsageHistory.day(day, calendar: calendar))
        {
            count += 1
        }
        return count
    }

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
        if !working.isEmpty {
            let today = UsageHistory.day(now, calendar: calendar)
            if activeDays.last != today {
                // By date, not by count: a day from a clock set ahead (or another time zone) must not push out a real one.
                let oldest = calendar.date(byAdding: .day, value: -Self.streakDays, to: calendar.startOfDay(for: now)) ?? now
                let cutoff = UsageHistory.day(oldest, calendar: calendar)
                activeDays = Set(activeDays + [today]).filter { $0 >= cutoff && $0 <= today }.sorted()
            }
            if streak(now: now, calendar: calendar) >= Self.streakDays { earned.insert(.weekStreak) }
        }
        platforms.formUnion(sessions.compactMap(\.platform).filter(Self.allPlatforms.contains))
        if platforms == Self.allPlatforms { earned.insert(.everyPlatform) }

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

    /// Counts the tool calls not seen before, like Wrapped does.
    public mutating func count(_ entries: [String: [Entry]]) -> [Achievement] {
        guard !unlocked.contains(.toolCalls1000) else { return [] }
        for (session, list) in entries {
            for entry in list where entry.kind == .tool && entry.name?.isEmpty == false {
                let id = entry.toolUseId.flatMap { $0.isEmpty ? nil : $0 } ?? "\(session)/\(entry.id)"
                if countedCalls.insert(id).inserted { toolCalls += 1 }
            }
        }
        guard toolCalls >= Self.toolCallGoal else { return [] }
        countedCalls = []
        return unlock([.toolCalls1000])
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
