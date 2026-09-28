import SwiftUI
import TalariaKit

struct ProviderQuotaBarsView: View {
    let providerID: String?
    let displayName: String
    let periods: [ProviderQuotaPeriodPresentation]
    let statusText: ProviderQuotaWidgetStatusText
    let resetDisplay: ProviderQuotaWidgetResetDisplay
    let trackColor: Color
    let requestedLineWidth: Double
    let showsPaceMarker: Bool
    let showsProviderIcon: Bool
    let providerIconStyle: ProviderIconStyle
    let arcColor: (ProviderQuotaPresentationState) -> Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if showsProviderIcon {
                    ProviderIconView(
                        providerID: providerID,
                        label: displayName,
                        size: 18,
                        style: providerIconStyle
                    )
                }
                Text(displayName)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }

            ForEach(periods) { period in
                VStack(spacing: 2) {
                    HStack(spacing: 4) {
                        Text(period.shortLabel)
                            .font(.caption2.weight(.semibold))
                        if let reset = period.resetLabel(display: resetDisplay) {
                            Text(reset)
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.5)
                        }
                        Spacer(minLength: 2)
                        if let value = period.valueLabel(statusText: statusText) {
                            Text(value)
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .lineLimit(1)
                                .minimumScaleFactor(0.55)
                        }
                    }

                    bar(period)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .accessibilityIdentifier("provider-quota-widget-bars")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private func bar(_ period: ProviderQuotaPeriodPresentation) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(trackColor)
                if let percent = period.state.percent {
                    Capsule()
                        .fill(arcColor(period.state))
                        .frame(width: proxy.size.width * min(max(percent, 0), 100) / 100)
                        .widgetAccentable()
                }
                if showsPaceMarker, let expected = period.state.expectedPercent {
                    Rectangle()
                        .fill(Color.primary)
                        .frame(width: 1.5)
                        .offset(
                            x: min(
                                max(proxy.size.width * min(max(expected, 0), 100) / 100 - 0.75, 0),
                                max(proxy.size.width - 1.5, 0)
                            )
                        )
                }
            }
        }
        .frame(height: min(max(requestedLineWidth * 0.6, 3), 8))
    }

    private var accessibilityLabel: String {
        ([displayName] + periods.map { $0.accessibilityDescription(resetDisplay: resetDisplay) })
            .joined(separator: ", ")
    }
}
