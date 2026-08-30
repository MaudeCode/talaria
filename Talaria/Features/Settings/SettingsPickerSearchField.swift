import SwiftUI

struct SettingsPickerSearchField: View {
    @Binding var text: String
    let prompt: LocalizedStringKey
    let clearLabel: LocalizedStringKey

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)

            TextField(prompt, text: $text)
                .font(.subheadline)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(clearLabel)
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .background(Color(.tertiarySystemFill).opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
