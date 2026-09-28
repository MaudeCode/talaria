import SwiftUI
import TalariaKit

struct ComposerStatusView: View {
    let text: String
    let isError: Bool
    let isDismissible: Bool
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(text)
                .font(AppFont.caption())
                .foregroundStyle(textColor)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            if isDismissible {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(AppFont.caption(weight: .bold))
                        .foregroundStyle(textColor)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss attachment error")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(backgroundColor)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(borderColor, lineWidth: 0.5)
        )
        .padding(.horizontal, 16)
    }

    private var textColor: Color {
        isError ? Color(.label) : Color.secondary
    }

    private var backgroundColor: Color {
        isError ? Color.red.opacity(0.08) : Color(.secondarySystemBackground)
    }

    private var borderColor: Color {
        isError ? Color.red.opacity(0.25) : Color(.separator).opacity(0.25)
    }
}
