import SwiftUI
import TalariaKit

struct DailyTokenRow: View {
    let day: InsightsDailyToken

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(day.date ?? String(localized: "Unknown Date"))
                .font(.subheadline)
                .fontWeight(.medium)

            HStack(spacing: 12) {
                Text("\(formatTokens(totalTokens)) tokens")
                Text("\(day.sessions ?? 0) sessions")

                if let cost = day.cost, cost > 0 {
                    Text(cost.formattedCost())
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private var totalTokens: Int {
        (day.inputTokens ?? 0) + (day.outputTokens ?? 0)
    }
}
