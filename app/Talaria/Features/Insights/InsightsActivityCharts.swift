import Charts
import SwiftUI
import TalariaKit

/// Sessions per weekday, in the server's order and labels.
struct InsightsWeekdayChart: View {
    let days: [InsightsActivityByDay]

    var body: some View {
        Chart(Array(days.enumerated()), id: \.offset) { index, day in
            BarMark(
                x: .value("Day", day.day ?? "\(index)"),
                y: .value("Sessions", day.sessions ?? 0)
            )
            .foregroundStyle(Color.accentColor)
            .clipShape(RoundedRectangle(cornerRadius: 2))
        }
        .chartXScale(domain: days.enumerated().map { $0.element.day ?? "\($0.offset)" })
        .chartXAxis { AxisMarks { AxisValueLabel() } }
        .chartYAxis { InsightsChartAxis.yAxis }
        .frame(height: 120)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Sessions by weekday")
        .accessibilityValue(Text(InsightsActivitySummary.weekday(days) ?? String(localized: "No data")))
        .accessibilityIdentifier("insights-weekday-chart")
    }
}

/// Sessions per hour of the day, 0 to 23.
struct InsightsHourChart: View {
    let hours: [InsightsActivityByHour]

    var body: some View {
        // Hours are categories like weekdays: a continuous axis draws 24 one-unit bars at no width.
        Chart(Array(hours.enumerated()), id: \.offset) { index, hour in
            BarMark(
                x: .value("Hour", String(hour.hour ?? index)),
                y: .value("Sessions", hour.sessions ?? 0)
            )
            .foregroundStyle(Color.accentColor)
            .clipShape(RoundedRectangle(cornerRadius: 2))
        }
        .chartXScale(domain: hours.enumerated().map { String($0.element.hour ?? $0.offset) })
        .chartXAxis {
            AxisMarks(values: ["0", "6", "12", "18"]) { value in
                AxisGridLine(stroke: InsightsChartAxis.gridStroke)
                AxisValueLabel {
                    if let hour = value.as(String.self).flatMap(Int.init) {
                        Text(InsightsActivitySummary.hourLabel(hour))
                    }
                }
            }
        }
        .chartYAxis { InsightsChartAxis.yAxis }
        .frame(height: 120)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Sessions by hour")
        .accessibilityValue(Text(InsightsActivitySummary.hour(hours) ?? String(localized: "No data")))
        .accessibilityIdentifier("insights-hour-chart")
    }
}

/// Wording shared by the Activity section header and the charts' accessibility values.
enum InsightsActivitySummary {
    static func weekday(_ days: [InsightsActivityByDay]) -> String? {
        guard let peak = days.max(by: { ($0.sessions ?? 0) < ($1.sessions ?? 0) }), (peak.sessions ?? 0) > 0 else { return nil }
        return String(localized: "Peak \(peak.day ?? String(localized: "Unknown")) · \(peak.sessions ?? 0) sessions")
    }

    static func hour(_ hours: [InsightsActivityByHour]) -> String? {
        guard let peak = hours.max(by: { ($0.sessions ?? 0) < ($1.sessions ?? 0) }), (peak.sessions ?? 0) > 0 else { return nil }
        return String(localized: "Peak \(hourLabel(peak.hour ?? 0)) · \(peak.sessions ?? 0) sessions")
    }

    static func hourLabel(_ hour: Int) -> String {
        "\(String(format: "%02d", hour)):00"
    }
}

/// One axis treatment for every Insights chart: solid hairline grid, three trailing y ticks.
enum InsightsChartAxis {
    static let gridStroke = StrokeStyle(lineWidth: 0.5)

    static var yAxis: some AxisContent {
        AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) {
            AxisGridLine(stroke: gridStroke)
            AxisValueLabel()
        }
    }
}
