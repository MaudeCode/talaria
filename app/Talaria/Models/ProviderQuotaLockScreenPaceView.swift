import SwiftUI
import TalariaKit

struct ProviderQuotaLockScreenPaceView: View {
    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()
    @AppStorage(
        ProviderQuotaLockScreenSettings.showsProviderIconKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var showsProviderIcon = ProviderQuotaLockScreenSettings.defaultShowsProviderIcon
    @AppStorage(
        ProviderQuotaLockScreenSettings.showsWindowKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var showsWindow = ProviderQuotaLockScreenSettings.defaultShowsWindow
    @AppStorage(
        ProviderQuotaLockScreenSettings.paceDetailKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var paceDetailRawValue = ProviderQuotaLockScreenPaceDetail.defaultValue.rawValue

    let source: ProviderQuotaWidgetSource
    let referenceDate: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                providerIdentity
                Spacer(minLength: 4)
                if showsWindow {
                    Text(state.window?.label ?? "Quota")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Text(paceLabel)
                .font(.headline.monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(detailLabel)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        }
        .accessibilityIdentifier("provider-quota-lock-pace")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(displayName), \(state.window?.label ?? String(localized: "Quota")), "
                + "\(paceLabel), Burn \(forecast.burnRateLabel), \(forecast.forecastLabel)"
        )
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
                .font(.caption.weight(.semibold))
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

    private var forecast: ProviderQuotaForecastSummary {
        ProviderQuotaForecastSummary(state: state)
    }

    private var paceLabel: String {
        state.paceLabel ?? String(localized: "Pace unavailable")
    }

    private var paceDetail: ProviderQuotaLockScreenPaceDetail {
        ProviderQuotaLockScreenPaceDetail(rawValue: paceDetailRawValue) ?? .defaultValue
    }

    private var detailLabel: String {
        switch paceDetail {
        case .burnAndForecast: "Burn \(forecast.burnRateLabel) · \(forecast.forecastLabel)"
        case .burn: String(localized: "Burn \(forecast.burnRateLabel)")
        case .forecast: forecast.forecastLabel
        }
    }

    private var displayName: String {
        ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: providerAliasesData
        )
    }
}
