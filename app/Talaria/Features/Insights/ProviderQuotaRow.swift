import SwiftUI
import TalariaKit

/// One quota source on Insights: every server window with its rail, reset, pace and forecast, then the source's
/// status and freshness. It renders the same presentation state as the widgets and the sidebar Quotas row, so the
/// three surfaces agree on colour, pace and forecast wording.
struct ProviderQuotaRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
        .accessibilityIdentifier("provider-quota-source-\(source.id)")
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Hide provider from Insights", hide)
    }

    private func content(at now: Date) -> some View {
        let widgetSource = ProviderQuotaWidgetSource(source, scopeID: scopeID, scopeLabel: "")
        let settings = evaluationSettings
        let periods = ProviderQuotaPresentation.periods(for: widgetSource, settings: settings, at: now)
        let sourceState = ProviderQuotaPresentation.state(for: widgetSource, settings: settings, at: now)

        return VStack(alignment: .leading, spacing: 10) {
            header

            ForEach(periods) { period in
                window(period, isFirst: period.id == periods.first?.id)
            }

            if periods.isEmpty, let quota = source.quota {
                credits(quota, state: sourceState)
            }

            if source.status != "available" {
                statusLine
            }

            if (!periods.isEmpty || source.status != "available"),
               let detail = source.details.first, !detail.isEmpty {
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

            freshness(sourceState, now: now)
        }
    }

    // MARK: Header

    private var header: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    providerTitle
                    HStack(spacing: 8) {
                        badges
                        Spacer(minLength: 4)
                        actionButtons
                    }
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    providerTitle
                        .layoutPriority(2)
                    badges
                        .fixedSize()
                    Spacer(minLength: 2)
                    actionButtons
                }
            }
        }
    }

    private var providerTitle: some View {
        HStack(spacing: 7) {
            ProviderIconView(providerID: source.providerID, label: displayName, size: 20)
            Text(displayName)
                .font(.headline)
                .lineLimit(2)
        }
    }

    @ViewBuilder
    private var badges: some View {
        if let plan = source.plan, !plan.isEmpty {
            Text(plan)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color(.tertiarySystemFill)))
        }
        if source.isActiveProvider {
            Image(systemName: "checkmark.circle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.green)
                .accessibilityLabel("Active provider")
        }
    }

    private var actionButtons: some View {
        HStack(spacing: -8) {
            Button(action: togglePin) {
                Image(systemName: isPinned ? "pin.fill" : "pin")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.plain)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .disabled(!isPinned && (!canPin || source.status == "removed"))
            .accessibilityLabel(isPinned ? "Remove \(displayName) from sidebar" : "Add \(displayName) to sidebar")
            .accessibilityHint(!isPinned && !canPin ? "Remove another pinned quota first." : "")

            Button(action: refresh) {
                if isRefreshing {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption.weight(.semibold))
                }
            }
            .buttonStyle(.plain)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .disabled(isRefreshing || source.status == "removed")
            .accessibilityLabel(Text("Refresh quota for \(displayName)"))
        }
    }

    // MARK: Windows

    private func window(_ period: ProviderQuotaPeriodPresentation, isFirst: Bool) -> some View {
        let state = period.state
        let tint = tint(for: state)
        let forecast = ProviderQuotaForecastSummary(state: state)

        return VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(state.window?.label ?? period.shortLabel)
                    .font(.subheadline.weight(.medium))
                Spacer(minLength: 8)
                if let percent = state.percent {
                    Text("\(percent.formatted(.percent.scale(1).precision(.fractionLength(0...1)))) \(state.modeLabel)")
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
                    tint: tint,
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

            if state.pace != nil {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Label(forecast.forecastLabel, systemImage: forecast.systemImage)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(forecastTint(forecast.outcome))
                    Spacer(minLength: 8)
                    Text(forecast.budgetLabel == "—"
                        ? String(localized: "\(forecast.burnRateLabel) burn")
                        : String(localized: "\(forecast.burnRateLabel) burn · \(forecast.budgetLabel)\(forecast.budgetUnitSuffix) budget"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
            }
        }
        .padding(.top, isFirst ? 0 : 2)
        .accessibilityElement(children: .combine)
    }

    private func resetLabel(_ resetAt: Date, period: ProviderQuotaPeriodPresentation) -> String {
        let exact = resetAt.formatted(.dateTime.weekday(.abbreviated).hour().minute())
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
                    Text("\(percent.formatted(.percent.scale(1).precision(.fractionLength(0...1)))) \(state.modeLabel)")
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
    private func freshness(_ state: ProviderQuotaPresentationState, now: Date) -> some View {
        let fetchedAt = ProviderQuotaDateParser.date(from: source.fetchedAt)
        if state.computedAt != nil || fetchedAt != nil {
            HStack(spacing: 5) {
                Image(systemName: state.isStale ? "clock.badge.exclamationmark" : "clock")
                if let computedAt = state.computedAt {
                    Text("As of \(computedAt.formatted(.dateTime.weekday(.abbreviated).hour().minute()))")
                }
                if let fetchedAt {
                    if state.computedAt != nil { Text("·") }
                    Text("Updated \(Self.relativeFormatter.localizedString(for: fetchedAt, relativeTo: now))")
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

    /// The stored widget settings, with the percentage mode Insights binds live.
    private var evaluationSettings: ProviderQuotaEvaluationSettings {
        let stored = ProviderQuotaEvaluationSettings.stored()
        return ProviderQuotaEvaluationSettings(
            percentageMode: percentageMode,
            colorBasis: stored.colorBasis,
            windowSelection: stored.windowSelection
        )
    }

    private func tint(for state: ProviderQuotaPresentationState) -> Color {
        ProviderQuotaWidgetPalette.arcColor(
            urgency: state.urgency,
            profile: ProviderQuotaWidgetResolvedProfile.resolve(id: nil)
        )
    }

    private func forecastTint(_ outcome: ProviderQuotaForecastOutcome) -> Color {
        switch outcome {
        case .unavailable: .secondary
        case .safe: .green
        case .warning: .orange
        }
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
