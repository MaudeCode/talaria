import SwiftUI
import TalariaKit

struct ModelBreakdownRow: View {
    let model: InsightsModelBreakdown

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(model.model ?? String(localized: "Unknown Model"))
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let cost = model.cost, cost > 0 {
                    Text(cost.formattedCost())
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            if let share = model.displayShare {
                ProgressRailView(percent: Double(share), height: 4)
            }

            HStack(spacing: 0) {
                Text(detailLine)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var detailLine: String {
        var parts = [
            String(localized: "\(formatTokens(model.totalTokens ?? tokenTotal)) tokens"),
            String(localized: "\(model.sessions ?? 0) sessions"),
        ]
        if let cacheHitPercent = model.cacheHitPercent {
            parts.append(String(localized: "\(insightsFormattedPercent(cacheHitPercent)) cache"))
        }
        if let share = model.displayShare {
            parts.append(String(localized: "\(share)% share"))
        }
        return parts.joined(separator: " · ")
    }

    private var tokenTotal: Int {
        (model.inputTokens ?? 0) + (model.outputTokens ?? 0)
    }
}
