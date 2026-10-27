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
        var text = worked >= 60 ? "\(WrappedLog.duration(worked)) of work" : "No task finished"
        if sessions > 0 { text += " in \(sessions) session\(sessions == 1 ? "" : "s")" }
        if let cost, cost >= 0.01 { text += String(format: ", $%.2f", cost) }
        return text + "."
    }
}
