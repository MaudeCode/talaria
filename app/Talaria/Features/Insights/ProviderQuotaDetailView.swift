import SwiftUI
import TalariaKit

/// One quota account's screen, opened from an Insights tile: every server window with its rail, pace and forecast,
/// the reset schedule, the account's plan and status, and the actions the old list row hid behind buttons.
struct ProviderQuotaDetailView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.timeZone) private var timeZone

    let source: ProviderQuotaSource
    let scopeID: String
    let displayName: String
    let percentageMode: ProviderQuotaPercentageMode
    let isRefreshing: Bool
    let isPinned: Bool
    let canPin: Bool
    /// A fixed clock for tests and visual references; nil renders against a minute-ticking clock.
    var referenceDate: Date? = nil
    let refresh: () -> Void
    let togglePin: () -> Void
    let hide: () -> Void
    let openProviderSettings: () -> Void

    var body: some View {
        Group {
            if let referenceDate {
                content(at: referenceDate)
            } else {
                TimelineView(.everyMinute) { context in
                    content(at: context.date)
                }
            }
        }
        .navigationTitle(displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: refresh) {
                    if isRefreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(isRefreshing || source.status == "removed")
                .accessibilityLabel(Text("Refresh quota for \(displayName)"))
            }
        }
        .accessibilityIdentifier("provider-quota-source-\(source.id)")
    }

    private func content(at now: Date) -> some View {
        let widgetSource = ProviderQuotaWidgetSource(source, scopeID: scopeID, scopeLabel: "")
        let settings = ProviderQuotaWindowsView.evaluationSettings(percentageMode: percentageMode)
        let periods = ProviderQuotaWindowsView.periods(for: widgetSource, settings: settings, at: now)

        return List {
            Section {
                header
            }

            Section {
                ProviderQuotaWindowsView(
                    source: source,
                    scopeID: scopeID,
                    percentageMode: percentageMode,
                    referenceDate: now
                )
            } header: {
                Text(source.windows.isEmpty ? "Credits" : "Windows")
            }

            if periods.contains(where: { $0.state.resetAt != nil }) {
                Section("Reset schedule") {
                    ForEach(periods) { period in
                        if let resetAt = period.state.resetAt {
                            LabeledContent(period.state.window?.label ?? period.shortLabel) {
                                VStack(alignment: .trailing, spacing: 2) {
                                    Text(resetAt.formatted(Date.FormatStyle(timeZone: timeZone).weekday(.abbreviated).month(.abbreviated).day().hour().minute()))
                                    if let countdown = period.resetLabel(display: .compact) {
                                        Text(countdown)
                                            .font(.caption.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            Section("Account") {
                if source.accountLabel != displayName, !source.accountLabel.isEmpty {
                    LabeledContent("Account", value: source.accountLabel)
                }
                if let plan = source.plan, !plan.isEmpty {
                    LabeledContent("Plan", value: plan)
                }
                LabeledContent("Status", value: source.unavailableReason ?? source.message ?? ProviderQuotaPresentation.statusLabel(source.status))
                if source.isActiveProvider {
                    LabeledContent("Active provider", value: String(localized: "Yes"))
                }
                if let fetchedAt = ProviderQuotaDateParser.date(from: source.fetchedAt) {
                    LabeledContent("Last checked", value: fetchedAt.formatted(Date.FormatStyle(timeZone: timeZone).weekday(.abbreviated).hour().minute()))
                }
                if let computedAt = ProviderQuotaDateParser.date(from: source.computedAt) {
                    LabeledContent("Pace as of", value: computedAt.formatted(Date.FormatStyle(timeZone: timeZone).weekday(.abbreviated).hour().minute()))
                }
                if let retryAt = ProviderQuotaDateParser.date(from: source.retryAfter) {
                    LabeledContent("Retry") { Text(retryAt, style: .relative) }
                }
            }

            Section {
                Button(action: togglePin) {
                    Label(isPinned ? "Unpin from Sidebar" : "Pin to Sidebar", systemImage: isPinned ? "pin.slash" : "pin")
                }
                .disabled(!isPinned && (!canPin || source.status == "removed"))
                .accessibilityHint(!isPinned && !canPin ? "Remove another pinned quota first." : "")
                if !source.providerID.isEmpty, let url = TalariaDeepLink.newChatWithProviderURL(providerID: source.providerID) {
                    Button { openURL(url) } label: {
                        Label("New Chat with \(displayName)", systemImage: "plus.bubble")
                    }
                }
                Button(action: openProviderSettings) {
                    Label("Provider Quota Settings", systemImage: "gearshape")
                }
                Button(role: .destructive, action: hide) {
                    Label("Hide from Insights", systemImage: "eye.slash")
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var header: some View {
        HStack(spacing: 12) {
            ProviderIconView(providerID: source.providerID, label: displayName, size: 36)
            VStack(alignment: .leading, spacing: 3) {
                Text(displayName)
                    .font(.title3.weight(.semibold))
                HStack(spacing: 8) {
                    if let plan = source.plan, !plan.isEmpty {
                        Text(plan)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(Color(.tertiarySystemFill)))
                    }
                    if source.isActiveProvider {
                        Label("Active provider", systemImage: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// The windows block every quota surface in Insights shares: per window the label, percent in the configured mode, a
/// rail tinted by the server urgency with the pace marker, the reset and countdown, the pace status, burn, budget and
/// forecast; then credits, status, detail, retry and freshness. The same presentation state drives the widgets.
struct ProviderQuotaWindowsView: View {
    /// Clock times follow the SwiftUI environment, so references and tests can pin a zone.
    @Environment(\.timeZone) private var timeZone

    let source: ProviderQuotaSource
    let scopeID: String
    let percentageMode: ProviderQuotaPercentageMode
    let referenceDate: Date

    var body: some View {
        let widgetSource = ProviderQuotaWidgetSource(source, scopeID: scopeID, scopeLabel: "")
        let settings = Self.evaluationSettings(percentageMode: percentageMode)
        let periods = Self.periods(for: widgetSource, settings: settings, at: referenceDate)
        let sourceState = ProviderQuotaPresentation.state(for: widgetSource, settings: settings, at: referenceDate)

        VStack(alignment: .leading, spacing: 12) {
            ForEach(periods) { period in
                window(period)
            }

            if periods.isEmpty, let quota = source.quota {
                credits(quota, state: sourceState)
            }

            if source.status != "available" {
                statusLine
            }

            if let detail = source.details.first, !detail.isEmpty {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let retryAt = ProviderQuotaDateParser.date(from: source.retryAfter) {
                Text("Retry \(retryAt, style: .relative)")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }

            freshness(sourceState)
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("provider-quota-windows-\(source.id)")
    }

    /// The stored widget settings, with the percentage mode Insights binds live.
    static func evaluationSettings(percentageMode: ProviderQuotaPercentageMode) -> ProviderQuotaEvaluationSettings {
        let stored = ProviderQuotaEvaluationSettings.stored()
        return ProviderQuotaEvaluationSettings(
            percentageMode: percentageMode,
            colorBasis: stored.colorBasis,
            windowSelection: stored.windowSelection
        )
    }

    /// Every server window in server order; the widgets' `periods` keeps only the three a widget can fit.
    static func periods(
        for source: ProviderQuotaWidgetSource,
        settings: ProviderQuotaEvaluationSettings,
        at now: Date
    ) -> [ProviderQuotaPeriodPresentation] {
        source.windows.enumerated().map { index, window in
            ProviderQuotaPeriodPresentation(
                id: index,
                shortLabel: ProviderQuotaPresentation.shortLabel(for: window),
                state: ProviderQuotaPresentation.state(for: source, settings: settings, at: now, windowOverride: window)
            )
        }
    }

    // MARK: Windows

    private func window(_ period: ProviderQuotaPeriodPresentation) -> some View {
        let state = period.state
        let forecast = ProviderQuotaForecastSummary(state: state)

        return VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(state.window?.label ?? period.shortLabel)
                    .font(.subheadline.weight(.medium))
                Spacer(minLength: 8)
                if let percent = state.percent {
                    Text("\(insightsFormattedPercent(percent)) \(state.modeLabel)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                } else if let detail = state.window?.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let percent = state.percent {
                ProgressRailView(
                    percent: percent,
                    markerPercent: state.expectedPercent,
                    tint: tint(for: state),
                    height: 6
                )
            }

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let resetAt = state.resetAt {
                    Text(resetLabel(resetAt, period: period))
                } else if let detail = state.window?.detail, !detail.isEmpty, state.percent != nil {
                    Text(detail)
                }
                Spacer(minLength: 8)
                if let paceLabel = state.paceLabel {
                    Text(paceLabel)
                } else if state.paceNeedsRefresh {
                    Text("Refresh needed")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if let pace = state.pace {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let serverForecast = state.forecast {
                        Label(forecast.forecastLabel, systemImage: forecast.systemImage)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(forecast.outcome.tint)
                        Spacer(minLength: 8)
                        Text(serverForecast.budgetPercent == nil
                            ? String(localized: "\(forecast.burnRateLabel) burn")
                            : String(localized: "\(forecast.burnRateLabel) burn · \(forecast.budgetLabel)\(forecast.budgetUnitSuffix) budget"))
                            .multilineTextAlignment(.trailing)
                    } else {
                        // A pace without a forecast still names its burn; the summary's placeholder wording is for widgets.
                        Spacer(minLength: 8)
                        Text("\(pace.burnRate.formatted(.number.precision(.fractionLength(2))))× burn")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func resetLabel(_ resetAt: Date, period: ProviderQuotaPeriodPresentation) -> String {
        // A weekday names a reset within the week; a monthly window's reset needs its date.
        let withinWeek = resetAt.timeIntervalSince(period.state.referenceDate) < 6 * 86_400
        let exact = withinWeek
            ? resetAt.formatted(Date.FormatStyle(timeZone: timeZone).weekday(.abbreviated).hour().minute())
            : resetAt.formatted(Date.FormatStyle(timeZone: timeZone).month(.abbreviated).day().hour().minute())
        guard let countdown = period.resetLabel(display: .compact) else {
            return String(localized: "Resets \(exact)")
        }
        return String(localized: "Resets \(exact) · \(countdown)")
    }

    // MARK: Credits (OpenRouter)

    @ViewBuilder
    private func credits(_ quota: ProviderQuotaAmount, state: ProviderQuotaPresentationState) -> some View {
        if let percent = state.percent {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("Credits")
                        .font(.subheadline.weight(.medium))
                    Spacer(minLength: 8)
                    Text("\(insightsFormattedPercent(percent)) \(state.modeLabel)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                ProgressRailView(percent: percent, tint: tint(for: state), height: 6)
                if let remaining = quota.limitRemaining {
                    Text("\(remaining.formatted()) credits remaining")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        } else if let remaining = quota.limitRemaining {
            Text("\(remaining.formatted()) credits remaining")
                .font(.subheadline)
        } else if source.status == "available" {
            statusLine
        }
    }

    // MARK: Status and freshness

    private var statusLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(source.unavailableReason ?? source.message ?? ProviderQuotaPresentation.statusLabel(source.status))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func freshness(_ state: ProviderQuotaPresentationState) -> some View {
        let fetchedAt = ProviderQuotaDateParser.date(from: source.fetchedAt)
        if state.computedAt != nil || fetchedAt != nil {
            HStack(spacing: 5) {
                Image(systemName: state.isStale ? "clock.badge.exclamationmark" : "clock")
                if let computedAt = state.computedAt {
                    Text("As of \(computedAt.formatted(Date.FormatStyle(timeZone: timeZone).weekday(.abbreviated).hour().minute()))")
                }
                if let fetchedAt {
                    if state.computedAt != nil { Text("·") }
                    Text("Updated \(Self.relativeFormatter.localizedString(for: fetchedAt, relativeTo: referenceDate))")
                }
                if state.isStale {
                    Text("· Stale")
                }
            }
            .font(.caption2)
            .foregroundStyle(state.isStale ? Color.orange : Color.secondary)
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: Helpers

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    private func tint(for state: ProviderQuotaPresentationState) -> Color {
        ProviderQuotaWidgetPalette.arcColor(
            urgency: state.urgency,
            profile: ProviderQuotaWidgetResolvedProfile.resolve(id: nil)
        )
    }

    private var statusColor: Color {
        switch source.status {
        case "available": .green
        case "exhausted", "dead", "invalid_key": .red
        case "removed", "unsupported", "no_key": .orange
        default: .secondary
        }
    }
}
