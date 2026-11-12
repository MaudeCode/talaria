import SwiftUI

/// The discrete sibling of SettingsSliderRow, using the native stepper actions.
struct SettingsStepperRow: View {
    let title: String
    var systemImage = "plusminus"
    @Binding var value: Int
    let range: ClosedRange<Int>
    var step = 1
    var format: (Int) -> String = { $0.formatted() }
    var accessibilityIdentifier: String? = nil

    init(title: String, systemImage: String = "plusminus", value: Binding<Int>,
         in range: ClosedRange<Int>, step: Int = 1,
         format: @escaping (Int) -> String = { $0.formatted() }, accessibilityIdentifier: String? = nil) {
        self.title = title
        self.systemImage = systemImage
        _value = value
        self.range = range
        self.step = step
        self.format = format
        self.accessibilityIdentifier = accessibilityIdentifier
    }

    var body: some View {
        Stepper(value: $value, in: range, step: step) {
            SettingsValueRow(title: title, systemImage: systemImage) {
                Text(format(value)).monospacedDigit().foregroundStyle(.secondary)
            }
            .environment(\.settingsIndexPage, nil)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: value = min(range.upperBound, value + step)
            case .decrement: value = max(range.lowerBound, value - step)
            @unknown default: break
            }
        }
        .accessibilityLabel(title)
        .accessibilityValue(format(value))
        .indexedSettingsRow(title: title, identifier: accessibilityIdentifier)
    }
}
