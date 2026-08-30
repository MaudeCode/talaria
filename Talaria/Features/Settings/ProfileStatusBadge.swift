import SwiftUI

struct ProfileStatusBadge: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Color.accentColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Color.accentColor.opacity(0.12), in: Capsule(style: .continuous))
    }
}
