import Charts
import SwiftUI
import TalariaKit

/// One category of an activity series: a weekday or an hour.
struct InsightsActivityCategory: Identifiable {
    let id: String
    /// The axis label; nil leaves the slot unlabeled so dense axes label every nth category.
    let label: String?
    let sessions: Int
}

/// Sessions per category (weekday or hour) in the server's order, as one accessibility element.
struct InsightsActivityChart: View {
    let categories: [InsightsActivityCategory]
    let accessibilityLabel: LocalizedStringKey
    let summary: String?
    let identifier: String

    var body: some View {
        Chart(categories) { category in
            BarMark(
                x: .value("Category", category.id),
                y: .value("Sessions", category.sessions)
            )
            .foregroundStyle(Color.accentColor)
            .clipShape(RoundedRectangle(cornerRadius: 2))
        }
        .chartXScale(domain: categories.map(\.id))
        .chartXAxis {
            // A category axis marks every value; only labeled categories get a line and a label.
            AxisMarks { value in
                if let id = value.as(String.self), let label = categories.first(where: { $0.id == id })?.label {
                    if categories.count > 12 { AxisGridLine(stroke: InsightsChartAxis.gridStroke) }
                    AxisValueLabel { Text(label) }
                }
            }
        }
        .chartYAxis { InsightsChartAxis.yAxis }
        .frame(height: 120)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(Text(accessibilityValue))
        .accessibilityIdentifier(identifier)
    }

    /// The peak, then every category with sessions, so VoiceOver reads the whole series.
    private var accessibilityValue: String {
        let values = categories.filter { $0.sessions > 0 }.map { category in
            "\(category.label ?? InsightsActivitySummary.hourLabel(Int(category.id) ?? 0)) \(category.sessions)"
        }
        guard !values.isEmpty else { return String(localized: "No data") }
        return ([summary].compactMap { $0 } + [values.joined(separator: ", ")]).joined(separator: ". ")
    }

    static func weekdays(_ days: [InsightsActivityByDay]) -> [InsightsActivityCategory] {
        days.enumerated().map { index, day in
            InsightsActivityCategory(id: day.day ?? "\(index)", label: day.day ?? "\(index)", sessions: day.sessions ?? 0)
        }
    }

    /// Hours 0 to 23, labeled every six hours.
    static func hours(_ hours: [InsightsActivityByHour]) -> [InsightsActivityCategory] {
        hours.enumerated().map { index, hour in
            let value = hour.hour ?? index
            return InsightsActivityCategory(
                id: String(value),
                label: value % 6 == 0 ? InsightsActivitySummary.hourLabel(value) : nil,
                sessions: hour.sessions ?? 0
            )
        }
    }
}

/// Wording for the view model's `peakDay` / `peakHour`, shared by the section headers and the charts' accessibility values.
enum InsightsActivitySummary {
    static func weekday(_ peak: InsightsActivityByDay?) -> String? {
        guard let peak, (peak.sessions ?? 0) > 0 else { return nil }
        return String(localized: "Peak \(peak.day ?? String(localized: "Unknown")) · \(peak.sessions ?? 0) sessions")
    }

    static func hour(_ peak: InsightsActivityByHour?) -> String? {
        guard let peak, (peak.sessions ?? 0) > 0 else { return nil }
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
