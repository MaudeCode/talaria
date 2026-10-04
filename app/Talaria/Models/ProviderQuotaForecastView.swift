import SwiftUI

struct ProviderQuotaForecastView: View {
    let plan: String?
    let state: ProviderQuotaPresentationState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Text(state.window?.label ?? "Quota")
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let plan, !plan.isEmpty {
                    Text(plan)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(.secondary.opacity(0.12), in: Capsule())
                }
            }

            if let resetAt = state.resetAt {
                Label {
                    Text(resetAt.formatted(.dateTime.weekday(.abbreviated).hour().minute()))
                        .lineLimit(1)
                } icon: {
                    Image(systemName: "calendar.badge.clock")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                metric(title: "Burn", value: burnRateLabel)
                metric(title: budgetTitle, value: budgetLabel)
            }

            Label(forecastLabel, systemImage: forecastSystemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(forecastTint)
                .lineLimit(2)

            HStack(spacing: 5) {
                Image(systemName: state.isStale ? "clock.badge.exclamationmark" : "clock")
                Group {
                    if let computedAt = state.computedAt {
                        Text("As of \(computedAt, style: .time)")
                    } else {
                        Text("Updated \(state.freshnessDate, style: .relative)")
                    }
                }
                .lineLimit(1)
            }
            .font(.caption2)
            .foregroundStyle(state.isStale ? .orange : .secondary)
        }
        .minimumScaleFactor(0.7)
        .accessibilityIdentifier("provider-quota-widget-forecast")
        .accessibilityElement(children: .combine)
    }

    private func metric(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value)
                .font(.caption.weight(.semibold).monospacedDigit())
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private var forecast: ProviderQuotaForecastSummary {
        ProviderQuotaForecastSummary(state: state)
    }

    private var burnRateLabel: String {
        forecast.burnRateLabel
    }

    private var budgetTitle: String {
        forecast.budgetTitle
    }

    private var budgetLabel: String {
        forecast.budgetLabel
    }

    private var forecastLabel: String {
        forecast.forecastLabel
    }

    private var forecastSystemImage: String {
        forecast.systemImage
    }

    private var forecastTint: Color {
        switch forecast.outcome {
        case .unavailable: .secondary
        case .safe: .green
        case .warning: .orange
        }
    }
}
