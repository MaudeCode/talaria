import SwiftUI
import TalariaKit

struct GitBranchPickerButton: View {
    @AppStorage(AppHaptics.isEnabledKey) private var isHapticsEnabled = true

    let currentBranch: String
    let branches: GitBranches?
    let isLoading: Bool
    let isSwitching: Bool
    let isDisabled: Bool
    let onSelect: (GitCheckoutTarget) -> Void
    let onCreate: (GitCheckoutTarget) -> Void
    let onRefresh: () -> Void

    @State private var showsPicker = false

    var body: some View {
        Button {
            HapticButtonHaptics.tap(isEnabled: isHapticsEnabled)
            showsPicker = true
        } label: {
            ComposerMetaControlLabel(
                title: currentBranch,
                systemImage: "arrow.triangle.branch",
                maxWidth: ComposerControlStrip.titleMaxWidth,
                color: .secondary,
                controlFont: AppFont.footnote(),
                chevronFont: AppFont.caption2()
            )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled || isLoading || isSwitching)
        .accessibilityLabel("Current Git branch")
        .accessibilityValue(currentBranch)
        .popover(isPresented: $showsPicker, arrowEdge: .bottom) {
            GitBranchPickerSheet(
                branches: branches,
                currentBranch: currentBranch,
                isLoading: isLoading,
                isSwitching: isSwitching,
                onSelect: { target in
                    showsPicker = false
                    onSelect(target)
                },
                onCreate: { target in
                    showsPicker = false
                    onCreate(target)
                },
                onRefresh: onRefresh
            )
            .frame(minWidth: 300, idealWidth: 360, maxWidth: 400, minHeight: 260, idealHeight: 360, maxHeight: 480)
            .presentationCompactAdaptation(.popover)
        }
    }
}
