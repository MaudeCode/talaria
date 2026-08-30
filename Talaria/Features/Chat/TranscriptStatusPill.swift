import SwiftUI

struct TranscriptStatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(AppFont.caption2(weight: .semibold))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12), in: Capsule())
    }
}
