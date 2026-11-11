import SwiftUI
import TalariaKit

/// Secondary text for status, errors, or live data only. Put explanations in the section's help.
struct SettingsFootnote: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(AppFont.caption())
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
