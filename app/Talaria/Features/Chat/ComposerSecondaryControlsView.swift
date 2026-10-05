import SwiftUI
import UIKit
import TalariaKit

struct ComposerSecondaryControlsView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let state: ComposerSecondaryControlsState
    let onChooseWorkspace: () -> Void
    let onSelectProfile: (ProfileSummary) -> Void
    let onSelectGitBranch: (GitCheckoutTarget) -> Void
    let onCreateGitBranch: (GitCheckoutTarget) -> Void
    let onRefreshGitBranches: () -> Void

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        selectorRow
                    }

                    if state.showsContextUsage {
                        ContextWindowIndicatorView(snapshot: state.contextWindowSnapshot)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    // The chips share the row ahead of the spacer, so width a collapsed chip
                    // leaves (TAL-484) goes to the next chip's title.
                    HStack(spacing: 8) {
                        selectorRow
                    }
                    .layoutPriority(1)
                    Spacer(minLength: 0)

                    if state.showsContextUsage {
                        ContextWindowIndicatorView(snapshot: state.contextWindowSnapshot)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var selectorRow: some View {
        if let workspaceTitle = state.workspaceTitle {
            ComposerWorkspaceSelectorButton(
                title: workspaceTitle,
                isDisabled: state.isDisabled,
                verticalPadding: verticalPadding,
                horizontalPadding: horizontalPadding,
                color: .secondary,
                controlFont: AppFont.footnote(),
                chevronFont: AppFont.caption2(),
                onTap: onChooseWorkspace
            )
        }

        if let selectedProfileTitle = state.selectedProfileTitle {
            ComposerProfileSelectorMenu(
                profileOptions: state.profileOptions,
                selectedProfileName: state.selectedProfileName,
                selectedProfileTitle: selectedProfileTitle,
                isDisabled: state.isDisabled,
                verticalPadding: verticalPadding,
                horizontalPadding: horizontalPadding,
                color: .secondary,
                controlFont: AppFont.footnote(),
                chevronFont: AppFont.caption2(),
                onSelectProfile: onSelectProfile
            )
        }

        if let gitBranch = state.gitBranch {
            GitBranchPickerButton(
                currentBranch: gitBranch.currentName,
                branches: gitBranch.branches,
                isLoading: gitBranch.isLoading,
                isSwitching: gitBranch.isSwitching,
                isDisabled: state.isDisabled,
                onSelect: onSelectGitBranch,
                onCreate: onCreateGitBranch,
                onRefresh: onRefreshGitBranches
            )
        }
    }

    private var verticalPadding: CGFloat { dynamicTypeSize.isAccessibilitySize ? 10 : 8 }
    private var horizontalPadding: CGFloat { dynamicTypeSize.isAccessibilitySize ? 16 : 14 }
}
