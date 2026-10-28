import Foundation

/// Hackathon mode (docs/pools.md): a pool against a deadline. The notch shows its countdown and puts a session in it as
/// one of its roles in one step. Mirrors shared/pool-hackathon.ts; both check shared/test/pool-countdown.json.
public enum PoolHackathon {
    /// The roles a hackathon pool starts with, when its notes name none.
    public static let roles = ["front", "back", "infra", "qa"]

    public static func roleLabel(_ role: String) -> String { role == "qa" ? "QA" : role }

    /// How long until the deadline: `2 h 05 min left`, `14 min left`, `Time is up`. Nil without a deadline that reads.
    public static func countdown(_ deadline: String?, now: Date = Date()) -> String? {
        guard let deadline, let end = ISO8601.parse(deadline) else { return nil }
        return label(milliseconds: max(0, end.timeIntervalSince(now) * 1000))
    }

    /// Less than fifteen minutes left, or none.
    public static func isLate(_ deadline: String?, now: Date = Date()) -> Bool {
        guard let deadline, let end = ISO8601.parse(deadline) else { return false }
        return end.timeIntervalSince(now) < 900
    }

    /// Never translated, like the rest of what the pool says: the same words on the website and in the notch.
    public static func label(milliseconds ms: Double) -> String {
        if ms <= 0 { return "Time is up" }
        if ms < 60_000 { return "Under a minute left" }
        let minutes = Int(ms / 60_000)
        if minutes < 60 { return "\(minutes) min left" }
        let (hours, rest) = (minutes / 60, minutes % 60)
        if hours < 24 { return rest == 0 ? "\(hours) h left" : "\(hours) h \(String(format: "%02d", rest)) min left" }
        let (days, restHours) = (hours / 24, hours % 24)
        return "\(days) day\(days == 1 ? "" : "s")\(restHours == 0 ? "" : " \(restHours) h") left"
    }

    /// The roles a session can join the pool as in one step: the notes' areas, else the usual four.
    public static func joinRoles(of state: PoolState) -> [String] {
        let named = state.areas.map(\.name).filter { !$0.isEmpty }
        return named.isEmpty ? roles : named
    }
}

extension PoolJoinForm {
    /// One step into a hackathon pool: the role, and everything else as the session is.
    public static func quick(_ session: SessionSummary, area: String) -> PoolJoinForm {
        var form = PoolJoinForm(session: session)
        form.area = area
        return form
    }
}
