import SwiftUI
import TalariaKit

struct ProviderQuotaLockScreenPercentageView: View {
    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()
    @AppStorage(
        ProviderQuotaLockScreenSettings.showsProviderIconKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var showsProviderIcon = ProviderQuotaLockScreenSettings.defaultShowsProviderIcon
    @AppStorage(
        ProviderQuotaLockScreenSettings.showsResetKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var showsReset = ProviderQuotaLockScreenSettings.defaultShowsReset

    let source: ProviderQuotaWidgetSource
    let referenceDate: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                providerIdentity
                Spacer(minLength: 4)
                Text(formattedPercent)
                    .font(.headline.monospacedDigit())
            }
            ProgressView(value: state.percent ?? 0, total: 100)
            if showsReset, let resetAt = state.resetAt {
                Text("Resets \(resetAt, style: .relative)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityIdentifier("provider-quota-lock-percentage")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private var providerIdentity: some View {
        if showsProviderIcon {
            ProviderIconView(
                providerID: source.providerID,
                label: displayName,
                size: 18,
                style: .silhouette
            )
        } else {
            Text(displayName)
                .font(.headline)
                .lineLimit(1)
        }
    }

    private var state: ProviderQuotaPresentationState {
        ProviderQuotaPresentation.state(
            for: source,
            settings: ProviderQuotaEvaluationSettings.stored(),
            at: referenceDate
        )
    }

    private var formattedPercent: String {
        guard let percent = state.percent else {
            return ProviderQuotaPresentation.statusLabel(source.status)
        }
        return percent.formatted(.percent.scale(1).precision(.fractionLength(0)))
    }

    private var displayName: String {
        ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: providerAliasesData
        )
    }

    private var accessibilityLabel: String {
        guard showsReset, let resetAt = state.resetAt else {
            return "\(displayName), \(formattedPercent)"
        }
        return "\(displayName), \(formattedPercent), resets \(resetAt.formatted(.relative(presentation: .numeric)))"
    }
}
