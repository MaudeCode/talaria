import SwiftUI
import TalariaKit

/// One quota account on the Insights Quotas tab: the account's name and plan, then every window with its percent,
/// meter, reset, forecast and pace cells (the same block the detail screen shows). Tapping opens the detail screen.
struct ProviderQuotaAccountRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let source: ProviderQuotaSource
    let scopeID: String
    let displayName: String
    let percentageMode: ProviderQuotaPercentageMode
    let isRefreshing: Bool
    let referenceDate: Date
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 12) {
                header
                ProviderQuotaWindowsView(
                    source: source,
                    scopeID: scopeID,
                    percentageMode: percentageMode,
                    referenceDate: referenceDate
                )
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("provider-quota-row-\(source.id)")
        .accessibilityElement(children: .contain)
        .accessibilityHint("Opens the account's reset schedule, details and actions.")
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            ProviderIconView(providerID: source.providerID, label: displayName, size: 20)
            Text(displayName)
                .font(.headline)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
            if let plan = source.plan, !plan.isEmpty {
                Text(plan)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color(.tertiarySystemFill)))
                    .fixedSize()
            }
            if source.isActiveProvider {
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.green)
                    .accessibilityLabel("Active provider")
            }
            Spacer(minLength: 4)
            if isRefreshing {
                ProgressView().controlSize(.small)
            }
            Image(systemName: "chevron.forward")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
    }
}

/// An account the server reports without quota windows or credits: its name and the reason, one line each.
struct ProviderQuotaUnavailableRow: View {
    let source: ProviderQuotaSource
    let displayName: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                ProviderIconView(providerID: source.providerID, label: displayName, size: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName)
                        .font(.subheadline.weight(.medium))
                    Text(source.unavailableReason ?? source.message ?? ProviderQuotaPresentation.statusLabel(source.status))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.forward")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("provider-quota-row-\(source.id)")
        .accessibilityElement(children: .combine)
    }
}
