import SwiftUI
import TalariaKit

/// Title, modified caption and trailing control on one row. When they cannot share it, as at
/// accessibility text sizes, the caption drops below so the title keeps whole words (TAL-466).
struct MemoryHeaderRow<Trailing: View>: View {
    let title: String
    let systemImage: String
    let modifiedAt: Date?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                Label(title, systemImage: systemImage)
                Spacer()
                modifiedCaption
                trailing
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Label(title, systemImage: systemImage)
                        .fixedSize(horizontal: false, vertical: true)
                        .layoutPriority(1)
                    Spacer(minLength: 0)
                    trailing
                }
                modifiedCaption
            }
        }
    }

    @ViewBuilder private var modifiedCaption: some View {
        if let modifiedAt {
            Text("Modified \(modifiedAt, style: .relative) ago")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
