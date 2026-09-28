import SwiftUI
import WidgetKit
import TalariaKit

struct ProviderQuotaAccessoryView: View {
    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()

    let source: ProviderQuotaWidgetSource
    let entry: ProviderQuotaTimelineEntry
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .accessoryInline:
            Text("\(displayName) \(formattedPercent)")
        case .accessoryCircular:
            Gauge(value: percent ?? 0, in: 0...100) {
                Text(displayName)
            } currentValueLabel: {
                Text(formattedPercent)
                    .font(.caption.weight(.semibold))
                    .minimumScaleFactor(0.7)
            }
            .gaugeStyle(.accessoryCircularCapacity)
        case .accessoryRectangular:
            ProviderQuotaLockScreenPercentageView(source: source, referenceDate: entry.date)
        default:
            EmptyView()
        }
    }

    private var state: ProviderQuotaPresentationState {
        ProviderQuotaPresentation.state(
            for: source,
            settings: ProviderQuotaEvaluationSettings.stored(),
            at: entry.date
        )
    }

    private var percent: Double? {
        state.percent
    }

    private var formattedPercent: String {
        guard let percent else { return ProviderQuotaPresentation.statusLabel(source.status) }
        return percent.formatted(.percent.scale(1).precision(.fractionLength(0)))
    }

    private var displayName: String {
        ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: providerAliasesData
        )
    }
}
