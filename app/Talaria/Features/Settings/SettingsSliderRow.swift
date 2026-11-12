import SwiftUI

/// Extends SettingsValueRow with a continuous, accessible value control.
struct SettingsSliderRow: View {
    let title: String
    var systemImage = "slider.horizontal.3"
    @Binding var value: Double
    var range: ClosedRange<Double>
    var step: Double? = nil
    var format: (Double) -> String = { $0.formatted() }
    var accessibilityIdentifier: String? = nil

    init(title: String, systemImage: String = "slider.horizontal.3", value: Binding<Double>,
         in range: ClosedRange<Double>, step: Double? = nil,
         format: @escaping (Double) -> String = { $0.formatted() }, accessibilityIdentifier: String? = nil) {
        self.title = title
        self.systemImage = systemImage
        _value = value
        self.range = range
        self.step = step
        self.format = format
        self.accessibilityIdentifier = accessibilityIdentifier
    }

    var body: some View {
        VStack(spacing: 6) {
            SettingsValueRow(title: title, systemImage: systemImage) {
                Text(format(value)).monospacedDigit().foregroundStyle(.secondary)
            }
            .environment(\.settingsIndexPage, nil)
            .accessibilityHidden(true)
            Group {
                if let step { Slider(value: $value, in: range, step: step) }
                else { Slider(value: $value, in: range) }
            }
                .accessibilityLabel(title)
                .accessibilityValue(format(value))
                .indexedSettingsRow(title: title, identifier: accessibilityIdentifier)
        }
    }
}
