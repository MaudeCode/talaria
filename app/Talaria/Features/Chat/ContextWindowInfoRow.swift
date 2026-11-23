import SwiftUI

struct ContextWindowInfoRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.caption)
                .fontWeight(.medium)
        }
        // One element, so a label is read with its value.
        .accessibilityElement(children: .combine)
    }
}
