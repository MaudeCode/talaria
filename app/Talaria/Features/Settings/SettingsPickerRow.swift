import SwiftUI

struct SettingsPickerRow<SelectionValue: Hashable, Options: View>: View {
    let title: String
    let systemImage: String
    @Binding var selection: SelectionValue
    @ViewBuilder let options: Options
    var accessibilityIdentifier: String? = nil
    var usesSegmentedControl = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(title: String, systemImage: String, selection: Binding<SelectionValue>,
         accessibilityIdentifier: String? = nil, usesSegmentedControl: Bool = false,
         @ViewBuilder options: () -> Options) {
        self.title = title
        self.systemImage = systemImage
        _selection = selection
        self.accessibilityIdentifier = accessibilityIdentifier
        self.usesSegmentedControl = usesSegmentedControl
        self.options = options()
    }

    var body: some View {
        Group {
            if usesSegmentedControl {
                Picker(title, selection: $selection) { options }
                    .pickerStyle(.segmented)
            } else if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    label
                    picker
                        // Native menu values ignore lineLimit and wrap at accessibility sizes.
                        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            } else {
                HStack(spacing: 12) {
                    label.lineLimit(1)
                    Spacer(minLength: 0)
                    picker
                }
            }
        }
        .accessibilityIdentifier(accessibilityIdentifier ?? "")
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    private var label: some View {
        SettingsRowLabel(title: title, systemImage: systemImage)
            .accessibilityHidden(true)
    }

    private var picker: some View {
        Picker(title, selection: $selection) { options }
            .pickerStyle(.menu)
            .labelsHidden()
            .tint(.secondary)
            .fixedSize()
            .layoutPriority(1)
            .accessibilityLabel(title)
    }
}
