import Foundation

/// The evening notification of Settings › Notch: how long Claude worked today, in how many sessions, and what it cost.
public enum DailySummary {
    /// Once a day, from `minutes` after midnight on, and only for that day: a Mac asleep until the next morning skips it.
    public static func isDue(at now: Date, minutes: Int, lastDay: String, calendar: Calendar = .current) -> Bool {
        guard lastDay != UsageHistory.day(now, calendar: calendar) else { return false }
        let start = calendar.startOfDay(for: now)
        let time = calendar.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: start) ?? start
        return now >= time
    }

    /// `3 h 20 of work in 5 sessions, $12.40.` Nil on a day without Claude. The cost only when there is one to show.
    public static func text(worked: TimeInterval, sessions: Int, cost: Double?) -> String? {
        guard worked >= 60 || sessions > 0 else { return nil }
        // Whole sentences: the order of the parts and the plural of sessions change with the language.
        let spent = cost.flatMap { $0 >= 0.01 ? Money.dollars($0) : nil }
        guard worked >= 60 else {
            return spent.map { String(core: "No task finished in \(sessions) sessions, \($0).") }
                ?? String(core: "No task finished in \(sessions) sessions.")
        }
        let time = WrappedLog.duration(worked)
        switch (sessions > 0, spent) {
        case (true, let spent?): return String(core: "\(time) of work in \(sessions) sessions, \(spent).")
        case (true, nil): return String(core: "\(time) of work in \(sessions) sessions.")
        case (false, let spent?): return String(core: "\(time) of work, \(spent).")
        case (false, nil): return String(core: "\(time) of work.")
        }
    }
}
