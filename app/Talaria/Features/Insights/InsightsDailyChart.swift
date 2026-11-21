import Accessibility
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

    /// The names of a bar's stacked parts. Tokens stack the server's input and output; cache reads are already part
    /// of input, so they appear in the read-out and values, not as a third part.
    var parts: [String] {
        self == .tokens ? [String(localized: "Input"), String(localized: "Output")] : [title]
    }

    /// The day's bar, part by part.
    func segments(_ day: InsightsDailyToken) -> [(name: String, value: Double)] {
        let values = self == .tokens ? [Double(day.inputTokens ?? 0), Double(day.outputTokens ?? 0)] : [value(day)]
        return Array(zip(parts, values))
    }

    func label(_ value: Double, precision: Int? = nil, locale: Locale) -> String {
        switch self {
        case .tokens: insightsCompactNumber(Int(value))
        case .cost: value.formattedCost(precision: precision, locale: locale)
        case .sessions: Int(value).formatted()
        }
    }
}

/// The whole server `daily_tokens` series as bars, one metric at a time; pressing a bar reads that row.
/// A range past 366 days arrives in month buckets (TAL-1117), each dated by its first day.
struct InsightsDailyChart: View {
    @Environment(\.locale) private var locale
    let days: [InsightsDailyToken]
    var monthly = false
    let metric: InsightsDailyMetric
    @State private var selectedDay: Date?

    /// Rows the chart can place, in server order.
    private var dated: [(day: Date, row: InsightsDailyToken)] {
        days.compactMap { row in row.day.map { ($0, row) } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            chart
                .frame(height: 170)
                .accessibilityIdentifier("insights-daily-chart")

            // Every day's figures, for VoiceOver and for reading exact values; the chart itself summarises.
            DisclosureGroup("Values") {
                ForEach(dated, id: \.day) { item in
                    LabeledContent(item.day.formatted(Self.dayFormat(monthly: monthly))) {
                        Text(Self.figures(item.row, locale: locale).joined(separator: " · "))
                            .accessibilityValue(Self.figures(item.row, precision: 4, locale: locale).joined(separator: ", "))
                            .font(.caption.monospacedDigit())
                            .multilineTextAlignment(.trailing)
                    }
                    .font(.caption)
                }
            }
            .font(.caption)
            .accessibilityIdentifier("insights-daily-values")
        }
    }

    private var unit: Calendar.Component { monthly ? .month : .day }

    /// The row whose bar a chart selection lands on: the one whose day, or month, holds the selected instant.
    static func row(at selected: Date, in days: [InsightsDailyToken], monthly: Bool) -> InsightsDailyToken? {
        days.first { row in
            row.day.map { Calendar.current.isDate($0, equalTo: selected, toGranularity: monthly ? .month : .day) } ?? false
        }
    }

    static func dayFormat(monthly: Bool) -> Date.FormatStyle {
        monthly ? .dateTime.month(.abbreviated).year() : .dateTime.month(.abbreviated).day()
    }

    /// A row's own figures: input, output and cache-read tokens, then sessions and cost.
    static func figures(_ row: InsightsDailyToken, compact: Bool = false, precision: Int? = nil, locale: Locale) -> [String] {
        let tokens: (Int) -> String = compact ? { insightsCompactNumber($0, locale: locale) } : { formatTokens($0, locale: locale) }
        return [
            String(localized: "\(tokens(row.inputTokens ?? 0)) input"),
            String(localized: "\(tokens(row.outputTokens ?? 0)) output"),
            row.cacheReadTokens.map { String(localized: "\(tokens($0)) cache read") },
            String(localized: "\(row.sessions ?? 0) sessions"),
            (row.cost ?? 0).formattedCost(precision: precision, locale: locale),
        ].compactMap { $0 }
    }

    /// What VoiceOver's chart detail and Audio Graph read: one data point per placed row, in server order.
    static func chartDescriptor(days: [InsightsDailyToken], metric: InsightsDailyMetric, monthly: Bool, locale: Locale) -> AXChartDescriptor {
        let dated = days.compactMap { row in row.day.map { (stamp: $0.timeIntervalSince1970, row: row) } }
        let stamps = dated.map(\.stamp)
        let values = dated.map { metric.value($0.row) }
        let format = dayFormat(monthly: monthly)
        let xAxis = AXNumericDataAxisDescriptor(
            title: monthly ? String(localized: "Month") : String(localized: "Day"),
            range: (stamps.min() ?? 0)...(stamps.max() ?? 0),
            gridlinePositions: []
        ) { Date(timeIntervalSince1970: $0).formatted(format) }
        let yAxis = AXNumericDataAxisDescriptor(title: metric.title, range: 0...max(values.max() ?? 0, 1), gridlinePositions: []) {
            metric.label($0, precision: 4, locale: locale)
        }
        let points = zip(dated, values).map { day, value in
            AXDataPoint(x: day.stamp, y: value, additionalValues: [], label: figures(day.row, precision: 4, locale: locale).joined(separator: ", "))
        }
        return AXChartDescriptor(
            title: String(localized: "\(metric.title) per day"),
            summary: nil,
            xAxis: xAxis,
            yAxis: yAxis,
            additionalAxes: [],
            series: [AXDataSeriesDescriptor(name: metric.title, isContinuous: false, dataPoints: points)]
        )
    }

    private var chart: some View {
        let dated = dated
        let dayFormat = Self.dayFormat(monthly: monthly)
        let selected = selectedDay.flatMap { Self.row(at: $0, in: days, monthly: monthly) }
        let parts = metric.parts
        return Chart {
            ForEach(dated, id: \.day) { item in
                ForEach(metric.segments(item.row), id: \.name) { segment in
                    BarMark(
                        x: .value("Day", item.day, unit: unit),
                        y: .value(metric.title, segment.value)
                    )
                    .foregroundStyle(by: .value("Part", segment.name))
                    .opacity(selected == nil || selected?.date == item.row.date ? 1 : 0.35)
                    .clipShape(RoundedRectangle(cornerRadius: 2))
                }
            }
            if let selected, let day = selected.day {
                RuleMark(x: .value("Selected day", day, unit: unit))
                    .foregroundStyle(.secondary)
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .overlay, alignment: .top, overflowResolution: .init(x: .fit(to: .plot), y: .fit(to: .plot))) {
                        readout(selected, day: day.formatted(dayFormat))
                    }
            }
        }
        .chartForegroundStyleScale(domain: parts, range: [Color.accentColor, Color.accentColor.opacity(0.5)].prefix(parts.count))
        .chartLegend(parts.count > 1 ? .visible : .hidden)
        .chartXSelection(value: $selectedDay)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: dated.count > 10 ? 4 : min(dated.count, 7))) {
                AxisGridLine(stroke: InsightsChartAxis.gridStroke)
                AxisValueLabel(format: dayFormat, collisionResolution: .greedy)
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                AxisGridLine(stroke: InsightsChartAxis.gridStroke)
                AxisValueLabel {
                    if let number = value.as(Double.self) {
                        Text(metric.label(number, locale: locale))
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(metric.title) per day"))
        .accessibilityValue(Text(accessibilitySummary(dated.map { ($0.day, metric.value($0.row)) }, dayFormat: dayFormat)))
        .accessibilityChartDescriptor(InsightsChartAccessibility { [days, metric, monthly, locale] in
            Self.chartDescriptor(days: days, metric: metric, monthly: monthly, locale: locale)
        })
    }

    /// The pressed row's own figures: input and output on one line; cache reads, sessions and cost on the next.
    /// An overlay annotation is offered the rule's width, so the box sets its own and wraps inside it.
    private func readout(_ row: InsightsDailyToken, day: String) -> some View {
        let figures = Self.figures(row, compact: true, locale: locale)
        return VStack(alignment: .leading, spacing: 1) {
            Text(day)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(figures.prefix(2).joined(separator: " · "))
                .font(.caption.weight(.semibold).monospacedDigit())
            Text(figures.dropFirst(2).joined(separator: " · "))
                .font(.caption.monospacedDigit())
        }
        .frame(width: 240, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 6))
    }

    private func accessibilitySummary(_ points: [(day: Date, value: Double)], dayFormat: Date.FormatStyle) -> String {
        guard let peak = points.max(by: { $0.value < $1.value }) else { return String(localized: "No data") }
        let peakValue = metric.label(peak.value, precision: 4, locale: locale)
        if monthly {
            return String(localized: "\(points.count) months, peak \(peakValue) in \(peak.day.formatted(dayFormat))")
        }
        return String(localized: "\(points.count) days, peak \(peakValue) on \(peak.day.formatted(dayFormat))")
    }
}

/// Hands VoiceOver an Insights chart's descriptor, its Audio Graph and each bar as a data point, built only when
/// VoiceOver asks for it.
struct InsightsChartAccessibility: AXChartDescriptorRepresentable {
    let make: () -> AXChartDescriptor

    func makeChartDescriptor() -> AXChartDescriptor { make() }
}
