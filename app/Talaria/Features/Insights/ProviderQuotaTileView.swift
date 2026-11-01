import SwiftUI
import TalariaKit

/// One quota account on the Insights Quotas tab: the Home Screen widget's own gauge or bars, drawn with the user's
/// widget defaults, so the tab and the widgets read the same way. Tapping opens the account's detail screen.
struct ProviderQuotaTileView: View {
    let source: ProviderQuotaSource
    let scopeID: String
    let displayName: String
    let isRefreshing: Bool
    let referenceDate: Date
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            ProviderQuotaWidgetSourceView(
                source: ProviderQuotaWidgetSource(source, scopeID: scopeID, scopeLabel: ""),
                configuration: ProviderQuotaWidgetConfigurationIntent(),
                compact: false,
                referenceDate: referenceDate,
                windowOverride: nil
            )
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 150)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(alignment: .topTrailing) {
                if isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                        .padding(10)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("provider-quota-tile-\(source.id)")
        .accessibilityLabel(displayName)
        .accessibilityHint("Opens the account's windows, pace and forecast.")
    }
}
