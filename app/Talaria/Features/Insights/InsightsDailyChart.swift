import Charts
import SwiftUI
import TalariaKit

/// What the daily chart plots; each is one server field per day.
enum InsightsDailyMetric: String, CaseIterable, Identifiable {
    case tokens
    case cost
    case sessions

    var id: String { rawValue }

    var title: String {
        switch self {
        case .tokens: String(localized: "Tokens")
        case .cost: String(localized: "Cost")
        case .sessions: String(localized: "Sessions")
        }
    }

    func value(_ day: InsightsDailyToken) -> Double {
        switch self {
        case .tokens: Double(day.totalTokens)
        case .cost: day.cost ?? 0
        case .sessions: Double(day.sessions ?? 0)
        }
    }

    func label(_ value: Double) -> String {
        switch self {
        case .tokens: insightsCompactNumber(Int(value))
        case .cost: value.formattedCost(collapsingZeroCents: true)
        case .sessions: Int(value).formatted()
        }
    }
}

/// The whole server `daily_tokens` series as bars, one metric at a time; dragging reads one day.
struct InsightsDailyChart: View {
    let days: [InsightsDailyToken]
    @Binding var metric: InsightsDailyMetric
    @State private var selectedDay: Date?

    private var points: [(day: Date, value: Double)] {
        days.compactMap { day in
            guard let date = day.day else { return nil }
            return (date, metric.value(day))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Metric", selection: $metric) {
                ForEach(InsightsDailyMetric.allCases) { metric in
                    Text(metric.title).tag(metric)
                }
            }
            .pickerStyle(.segmented)

            chart
                .frame(height: 170)
                .accessibilityIdentifier("insights-daily-chart")

            // Every day's figures, for VoiceOver and for reading exact values; the chart itself summarises.
            DisclosureGroup("Values") {
                ForEach(days.filter { $0.day != nil }, id: \.date) { day in
                    LabeledContent(day.day?.formatted(.dateTime.month(.abbreviated).day()) ?? day.date ?? "") {
                        Text(valueLine(day))
                            .font(.caption.monospacedDigit())
                            .multilineTextAlignment(.trailing)
                    }
                    .font(.caption)
                }
            }
            .font(.caption)
            .accessibilityIdentifier("insights-daily-values")
        }
        .padding(.vertical, 4)
    }

    private func valueLine(_ day: InsightsDailyToken) -> String {
        [
            String(localized: "\(formatTokens(day.totalTokens)) tokens"),
            String(localized: "\(day.sessions ?? 0) sessions"),
            (day.cost ?? 0).formattedCost(collapsingZeroCents: true),
        ].joined(separator: " · ")
    }

    private var chart: some View {
        let points = points
        let selected = selectedDay.flatMap { selected in
            points.min { abs($0.day.timeIntervalSince(selected)) < abs($1.day.timeIntervalSince(selected)) }
        }
        return Chart {
            ForEach(points, id: \.day) { point in
                BarMark(
                    x: .value("Day", point.day, unit: .day),
                    y: .value(metric.title, point.value)
                )
                .foregroundStyle(selected == nil || selected?.day == point.day ? Color.accentColor : Color.accentColor.opacity(0.35))
                .clipShape(RoundedRectangle(cornerRadius: 2))
            }
            if let selected {
                RuleMark(x: .value("Selected day", selected.day, unit: .day))
                    .foregroundStyle(.secondary)
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .top, alignment: .center, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(selected.day.formatted(.dateTime.month(.abbreviated).day()))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(metric.label(selected.value))
                                .font(.caption.weight(.semibold).monospacedDigit())
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 6))
                    }
            }
        }
        .chartXSelection(value: $selectedDay)
        .accessibilityElement(children: .ignore)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: points.count > 10 ? 4 : min(points.count, 7))) {
                AxisGridLine(stroke: InsightsChartAxis.gridStroke)
                AxisValueLabel(format: .dateTime.month(.abbreviated).day())
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                AxisGridLine(stroke: InsightsChartAxis.gridStroke)
                AxisValueLabel {
                    if let number = value.as(Double.self) {
                        Text(metric.label(number))
                    }
                }
            }
        }
        .accessibilityLabel(Text("\(metric.title) per day"))
        .accessibilityValue(Text(accessibilitySummary(points)))
    }

    private func accessibilitySummary(_ points: [(day: Date, value: Double)]) -> String {
        guard let peak = points.max(by: { $0.value < $1.value }) else { return String(localized: "No data") }
        return String(localized: "\(points.count) days, peak \(metric.label(peak.value)) on \(peak.day.formatted(.dateTime.month(.abbreviated).day()))")
    }
}
