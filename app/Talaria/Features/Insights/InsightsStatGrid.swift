import SwiftUI
import TalariaKit

/// One headline figure of the analytics period.
struct InsightsStat: Identifiable {
    let id: String
    let title: String
    /// The short value the grid prints, such as `1.2M`.
    let value: String
    /// The exact value for assistive technology, such as `1,234,567`; nil when `value` is already exact.
    var exactValue: String? = nil
}

/// The period's totals in two columns, so every figure sits above the fold.
struct InsightsStatGrid: View {
    let stats: [InsightsStat]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 16, alignment: .topLeading)], alignment: .leading, spacing: 14) {
            ForEach(stats) { stat in
                VStack(alignment: .leading, spacing: 2) {
                    Text(stat.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(stat.value)
                        .font(.title3.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(stat.title), \(stat.exactValue ?? stat.value)")
            }
        }
        .padding(.vertical, 4)
    }
}
