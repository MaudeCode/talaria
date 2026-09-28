import SwiftUI
import UIKit
import TalariaKit

struct SettingsTextFieldRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let title: String
    @Binding var text: String
    let placeholder: String
    var keyboardType: UIKeyboardType = .default
    var autocapitalization: TextInputAutocapitalization = .words
    var isSecure = false
    var submitLabel: SubmitLabel = .return
    var onSubmit: (() -> Void)? = nil

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 6) {
                    titleLabel
                    textField
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                HStack(spacing: 12) {
                    titleLabel

                    Spacer(minLength: 12)

                    textField
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 190)
                }
            }
        }
    }

    private var titleLabel: some View {
        Text(title)
            .font(AppFont.subheadline())
    }

    @ViewBuilder
    private var textField: some View {
        Group {
            if isSecure {
                SecureField(placeholder, text: $text)
            } else {
                TextField(placeholder, text: $text)
            }
        }
        .font(AppFont.subheadline())
        .textInputAutocapitalization(autocapitalization)
        .autocorrectionDisabled()
        .keyboardType(keyboardType)
        .submitLabel(submitLabel)
        .onSubmit { onSubmit?() }
    }
}
