import SwiftUI
import TalariaKit

struct ModelBreakdownRow: View {
    let model: InsightsModelBreakdown

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.model ?? String(localized: "Unknown Model"))
                .font(.subheadline)
                .fontWeight(.medium)
                .lineLimit(1)

            HStack(spacing: 12) {
                Text("\(formatTokens(model.totalTokens ?? tokenTotal)) tokens")
                Text("\(model.sessions ?? 0) sessions")

                if let cost = model.cost, cost > 0 {
                    Text(cost.formattedCost())
                }

                if let share = model.displayShare {
                    Text("\(share)% share")
                }

                if let cacheHitPercent = model.cacheHitPercent {
                    Text("\(insightsFormattedPercent(cacheHitPercent)) cache")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private var tokenTotal: Int {
        (model.inputTokens ?? 0) + (model.outputTokens ?? 0)
    }
}
