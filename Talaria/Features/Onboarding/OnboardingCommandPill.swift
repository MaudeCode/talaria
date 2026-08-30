import SwiftUI
import UIKit

struct OnboardingCommandPill: View {
    let text: String
    var prefix: String? = "$"
    var copyValue: String?
    @State private var didCopy = false

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 0) {
                if let prefix {
                    Text("\(prefix) ")
                        .foregroundStyle(.white.opacity(0.28))
                }

                Text(text)
                    .foregroundStyle(.white.opacity(0.78))
                    .lineLimit(1)
                    .minimumScaleFactor(0.62)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let copyValue {
                Button {
                    UIPasteboard.general.string = copyValue
                    didCopy = true
                } label: {
                    Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(didCopy ? Color(red: 0.45, green: 0.92, blue: 0.56) : .white.opacity(0.76))
                        .frame(width: 28, height: 28)
                        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(didCopy ? String(localized: "Copied Web UI repository link") : String(localized: "Copy Web UI repository link"))
            }
        }
        .font(.system(.caption, design: .monospaced, weight: .medium))
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.white.opacity(0.055))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }
}
