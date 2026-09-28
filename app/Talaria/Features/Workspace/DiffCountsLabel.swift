import SwiftUI
import TalariaKit

struct DiffCountsLabel: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: "+\(additions)").foregroundStyle(.green)
            Text(verbatim: "−\(deletions)").foregroundStyle(.red)
        }
        .font(AppFont.mono(style: .caption, weight: .semibold))
        .monospacedDigit()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            Text("\(additions) added") + Text(verbatim: ", ") + Text("\(deletions) removed")
        )
    }
}
