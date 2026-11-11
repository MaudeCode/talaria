import SwiftUI
import TalariaKit

struct SettingsStatusPill: View {
    let label: String
    var tint: Color = .secondary
    var lineLimit: Int? = 1

    var body: some View {
        Text(label)
            .font(AppFont.caption(weight: .semibold))
            .foregroundStyle(tint)
            .lineLimit(lineLimit)
            .fixedSize(horizontal: false, vertical: true)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Capsule(style: .continuous).fill(tint.opacity(0.12)))
    }
}
