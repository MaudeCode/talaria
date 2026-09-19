import SwiftUI

struct CompactStatusRow: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 24)
                .accessibilityHidden(true)

            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            Spacer(minLength: 0)
        }
        .frame(minHeight: 42)
    }
}
