import SwiftUI
import TontonCore

/// When Claude works, per weekday and hour over the last 13 weeks: the brighter the cell, the more time.
struct BusyHoursMap: View {
    let grid: [BusyHours.Row]
    private let calendar = Calendar.current
    private static let labelWidth: CGFloat = 34

    var body: some View {
        let peak = grid.flatMap(\.hours).max() ?? 0
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 3) {
                Color.clear.frame(width: Self.labelWidth, height: 1)
                ForEach(0..<24, id: \.self) { hour in
                    Text(hour % 6 == 0 ? hourName(hour) : "")
                        .font(.system(size: 9))
                        .foregroundStyle(Theme.textFaint)
                        .fixedSize()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            ForEach(grid, id: \.weekday) { row in
                HStack(spacing: 3) {
                    Text(calendar.shortWeekdaySymbols[row.weekday - 1])
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textDim)
                        .frame(width: Self.labelWidth, alignment: .leading)
                    ForEach(0..<24, id: \.self) { hour in
                        RoundedRectangle(cornerRadius: 2.5)
                            .fill(color(row.hours[hour], peak: peak))
                            .aspectRatio(1, contentMode: .fit)
                            .help(detail(weekday: row.weekday, hour: hour, seconds: row.hours[hour]))
                    }
                }
            }
            if let busiest = BusyHours.busiest(grid) {
                Text("Busiest: \(span(weekday: busiest.weekday, hour: busiest.hour))")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textDim)
                    .padding(.top, 8)
            }
        }
    }

    /// Empty hours stay faint; the others scale up to the busiest one.
    private func color(_ seconds: TimeInterval, peak: TimeInterval) -> Color {
        guard seconds > 0, peak > 0 else { return Theme.ink.opacity(0.06) }
        return Theme.accent.opacity(0.2 + 0.8 * seconds / peak)
    }

    private func detail(weekday: Int, hour: Int, seconds: TimeInterval) -> String {
        let when = span(weekday: weekday, hour: hour)
        return seconds > 0 ? "\(when): \(WrappedLog.duration(seconds)) in 13 weeks" : when
    }

    private func span(weekday: Int, hour: Int) -> String {
        "\(calendar.weekdaySymbols[weekday - 1]), \(hourName(hour))–\(hourName((hour + 1) % 24))"
    }

    /// `14:00` or `2 PM`, as this Mac shows hours.
    private func hourName(_ hour: Int) -> String {
        let date = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: Date()) ?? Date()
        return date.formatted(.dateTime.hour())
    }
}
