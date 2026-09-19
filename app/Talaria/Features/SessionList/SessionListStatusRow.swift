import SwiftUI

struct SessionListStatusRow: View {
    let title: String
    let description: String?
    let systemImage: String
    var descriptionLineLimit: Int?

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: systemImage)
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 24)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityAddTraits(.isHeader)

                if let description {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(descriptionLineLimit)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 0)
        }
        .frame(minHeight: 42)
    }
}
