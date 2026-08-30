import SwiftUI

struct SkillLinkedFilesSection: View {
    let fileNames: [String]
    let onSelect: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Linked Files")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 20)

            VStack(spacing: 0) {
                ForEach(Array(fileNames.enumerated()), id: \.element) { index, fileName in
                    Button {
                        onSelect(fileName)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "doc.text")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.primary)
                                .frame(width: 34, height: 34)
                                .background(Color(.tertiarySystemFill).opacity(0.7), in: Circle())

                            Text(fileName)
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                                .lineLimit(1)

                            Spacer(minLength: 8)

                            Image(systemName: "chevron.forward")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if index < fileNames.count - 1 {
                        Divider()
                            .padding(.leading, 54)
                    }
                }
            }
            .padding(.horizontal, 20)
        }
    }
}
