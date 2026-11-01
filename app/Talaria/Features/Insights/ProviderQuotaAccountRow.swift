import SwiftUI
import TalariaKit

/// One quota account on the Insights Quotas tab: the account's name and plan, then every window with its rail, pace
/// and forecast (the same block the detail screen and the Web tab show). Tapping opens the account's detail screen.
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
            VStack(alignment: .leading, spacing: 10) {
                header
                ProviderQuotaWindowsView(
                    source: source,
                    scopeID: scopeID,
                    percentageMode: percentageMode,
                    referenceDate: referenceDate
                )
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("provider-quota-row-\(source.id)")
        .accessibilityElement(children: .contain)
        .accessibilityHint("Opens the account's reset schedule, details and actions.")
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            ProviderIconView(providerID: source.providerID, label: displayName, size: 18)
            Text(displayName)
                .font(.subheadline.weight(.semibold))
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
