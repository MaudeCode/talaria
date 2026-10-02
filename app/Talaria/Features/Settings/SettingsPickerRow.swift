import SwiftUI

struct SettingsPickerRow<SelectionValue: Hashable, Options: View>: View {
    let title: String
    let systemImage: String
    @Binding var selection: SelectionValue
    @ViewBuilder let options: Options

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        title: String,
        systemImage: String,
        selection: Binding<SelectionValue>,
        @ViewBuilder options: () -> Options
    ) {
        self.title = title
        self.systemImage = systemImage
        _selection = selection
        self.options = options()
    }

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                stacked
            } else {
                // Side by side only while the title and the selected value each fit on one
                // line; otherwise the value moves under the title instead of either wrapping.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        label
                            .fixedSize()

                        Spacer(minLength: 12)

                        picker
                            .fixedSize()
                    }

                    stacked
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    private var stacked: some View {
        VStack(alignment: .leading, spacing: 8) {
            label

            picker
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var label: some View {
        SettingsRowLabel(title: title, systemImage: systemImage)
            .accessibilityHidden(true)
    }

    private var picker: some View {
        Picker(title, selection: $selection) {
            options
        }
        .pickerStyle(.menu)
        .labelsHidden()
        // Secondary like the other settings values; outside a glass card a menu picker turns blue.
        .tint(.secondary)
        .accessibilityLabel(Text(title))
    }
}
