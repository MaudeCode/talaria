import SwiftUI
import TalariaKit

struct SessionRowStateBadge: View {
    let badge: SessionRowStateBadgeKind

    var body: some View {
        Text(badge.title)
            .font(AppFont.caption2(weight: .semibold))
            .foregroundStyle(badge.tint)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(badge.tint.opacity(0.12), in: Capsule())
            .accessibilityHidden(true)
    }
}
