import SwiftUI
import TalariaKit

struct GitAheadBehindBadges: View {
    let ahead: Int
    let behind: Int

    var body: some View {
        if ahead > 0 || behind > 0 {
            Text(verbatim: "↑\(ahead) ↓\(behind)")
                .font(AppFont.mono(style: .caption, weight: .semibold))
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }
}
