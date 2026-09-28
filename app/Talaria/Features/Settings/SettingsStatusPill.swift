import SwiftUI
import TalariaKit

struct SettingsStatusPill: View {
    let label: String
    var tint: Color = .secondary

    var body: some View {
        Text(label)
            .font(AppFont.caption(weight: .semibold))
            .foregroundStyle(tint)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Capsule(style: .continuous).fill(tint.opacity(0.12)))
    }
}
