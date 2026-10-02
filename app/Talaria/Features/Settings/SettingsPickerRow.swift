import SwiftUI

struct SettingsPickerRow<SelectionValue: Hashable, Options: View>: View {
    let title: String
    let systemImage: String
    @Binding var selection: SelectionValue
    @ViewBuilder let options: Options

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var menuChromeWidth: CGFloat = 44

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
                // Side by side only while the title and the widest value each fit on one line;
                // otherwise the value moves under the title instead of either wrapping. Sizing for
                // the widest value keeps the layout fixed when the selection changes.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        label
                            .fixedSize()

                        Spacer(minLength: 0)

                        ZStack(alignment: .trailing) {
                            widestValue
                            picker
                                .fixedSize()
                        }
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

    /// Every option overlaid and hidden: as wide as the widest value plus the menu's chevron.
    /// ponytail: `menuChromeWidth` covers the iOS 26 menu's chevron and padding (about 40 pt);
    /// a menu style wider than that lets a row switch layout with its value again.
    private var widestValue: some View {
        ZStack(alignment: .trailing) {
            options
        }
        .padding(.trailing, menuChromeWidth)
        .fixedSize()
        .hidden()
        .accessibilityHidden(true)
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
