import SwiftUI
import TalariaKit

struct SidebarDisclosureChevron: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    let isExpanded: Bool

    // Rotate inside a square box so the pivot is the visual center; the outer
    // frame keeps a fixed slot so the chevron never shifts horizontally or
    // vertically. A value-based animation rotates it in place (and is skipped
    // under Reduce Motion) regardless of the ambient List transaction.
    // `chevron.forward` mirrors to point leading-ward under RTL; the expand
    // rotation reverses there so the open state still points down (issue #294).
    var body: some View {
        Image(systemName: "chevron.forward")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: 24, height: 24)
            .rotationEffect(
                .degrees(RTLLayout.disclosureChevronRotationDegrees(
                    isExpanded: isExpanded,
                    isRightToLeft: layoutDirection == .rightToLeft
                )),
                anchor: .center
            )
            .frame(width: 24, height: 40)
            .animation(SessionListMotion.disclosureAnimation(reduceMotion: reduceMotion), value: isExpanded)
            .accessibilityHidden(true)
    }
}
