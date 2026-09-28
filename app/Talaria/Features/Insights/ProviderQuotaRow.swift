import SwiftUI
import TalariaKit

struct ProviderQuotaRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let source: ProviderQuotaSource
    let displayName: String
    let percentageMode: ProviderQuotaPercentageMode
    let isRefreshing: Bool
    let isPinned: Bool
    let canPin: Bool
    let refresh: () -> Void
    let togglePin: () -> Void
    let hide: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
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
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    providerTitle
                        .layoutPriority(2)
                    badges
                        .fixedSize()
                    Spacer(minLength: 2)
                    actionButtons
                }
            }

            if !source.windows.isEmpty {
                ForEach(Array(source.windows.enumerated()), id: \.offset) { index, window in
                    quotaWindow(window, showsUpdatedAt: index == source.windows.count - 1)
                }
            } else if let quota = source.quota {
                openRouterQuota(quota)
            } else if source.status != "available" {
                statusLine
            }

            if (!source.windows.isEmpty || source.status != "available"),
               let detail = source.details.first,
               !detail.isEmpty {
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

            if source.windows.isEmpty,
               let fetchedAt = ProviderQuotaDateParser.date(from: source.fetchedAt) {
                HStack {
                    Spacer(minLength: 0)
                    Text("Updated \(fetchedAt, style: .relative)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .accessibilityIdentifier("provider-quota-source-\(source.id)")
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Hide provider from Insights", hide)
    }

    private var providerTitle: some View {
        HStack(spacing: 7) {
            ProviderIconView(providerID: source.providerID, label: displayName, size: 18)
            Text(displayName)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
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

    private func quotaWindow(_ window: ProviderQuotaWindow, showsUpdatedAt: Bool) -> some View {
        let resetAt = ProviderQuotaDateParser.date(from: window.resetAt)
        let updatedAt = showsUpdatedAt ? ProviderQuotaDateParser.date(from: source.fetchedAt) : nil

        return VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.label)
                    .font(.footnote.weight(.medium))
                Spacer(minLength: 8)
                if let percent = ProviderQuotaPresentation.percent(window, mode: percentageMode) {
                    Text(percentageText(percent))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            if let percent = ProviderQuotaPresentation.percent(window, mode: percentageMode) {
                ProgressView(value: percent, total: 100)
                    .tint(progressTint(percent))
                    .accessibilityValue(Text(percentageText(percent)))
            }

            if resetAt != nil || window.detail?.isEmpty == false || updatedAt != nil {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let resetAt {
                        Text("Resets \(resetAt, style: .relative)")
                    } else if let detail = window.detail, !detail.isEmpty {
                        Text(detail)
                    }

                    Spacer(minLength: 8)

                    if let updatedAt {
                        Text("Updated \(updatedAt, style: .relative)")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func openRouterQuota(_ quota: ProviderQuotaAmount) -> some View {
        if let usage = quota.usage, let limit = quota.limit, limit > 0 {
            let used = min(max(usage / limit * 100, 0), 100)
            let percent = percentageMode == .used ? used : 100 - used
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("Credits")
                        .font(.footnote.weight(.medium))
                    Spacer(minLength: 8)
                    Text(percentageText(percent))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                ProgressView(value: percent, total: 100)
                    .tint(progressTint(percent))
            }
            .accessibilityElement(children: .combine)
        } else if let remaining = quota.limitRemaining {
            Text("\(remaining.formatted()) credits remaining")
                .font(.footnote)
        } else {
            statusLine
        }
    }

    private var statusLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(source.unavailableReason ?? source.message ?? statusLabel)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func percentageText(_ percent: Double) -> String {
        let suffix = percentageMode == .used ? String(localized: "used") : String(localized: "remaining")
        return "\(insightsFormattedPercent(percent)) \(suffix)"
    }

    private func progressTint(_ percent: Double) -> Color {
        if percentageMode == .used {
            return percent >= 90 ? .red : percent >= 75 ? .orange : .accentColor
        }
        return percent <= 10 ? .red : percent <= 25 ? .orange : .accentColor
    }

    private var statusLabel: String {
        ProviderQuotaPresentation.statusLabel(source.status)
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
