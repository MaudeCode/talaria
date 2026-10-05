import SwiftUI
import UIKit
import TalariaKit

/// Web's `.composer-strip` measurements (TAL-629).
enum ComposerControlStrip {
    static let cornerRadius: CGFloat = 12
    /// Width cap for every control but the model; wider controls scroll.
    static let titleMaxWidth: CGFloat = 180

    /// Web's `--composer-border-color`: the card's outline and the strip's, so the card's bottom
    /// edge reads as a seam over the strip.
    static func borderColor(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark ? Color.white.opacity(0.12) : Color.black.opacity(0.12)
    }

    /// The strip sits a shade back from the card it hangs from.
    static func recessTint(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark ? Color.black.opacity(0.18) : Color.black.opacity(0.035)
    }
}

/// The strip under the composer card: the model and reasoning controls, then workspace, branch and
/// profile. The strip is the only background; its controls are plain buttons, like T3 Code's footer.
struct ComposerSecondaryControlsView<Leading: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.colorScheme) private var colorScheme

    let state: ComposerSecondaryControlsState
    let onChooseWorkspace: () -> Void
    let onSelectProfile: (ProfileSummary) -> Void
    let onSelectGitBranch: (GitCheckoutTarget) -> Void
    let onCreateGitBranch: (GitCheckoutTarget) -> Void
    let onRefreshGitBranches: () -> Void
    @ViewBuilder let leading: Leading

    @State private var edgeFades = ComposerStripEdgeFades(leading: false, trailing: false)

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                // Large text wraps the two groups onto their own lines instead of scrolling.
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 12) { leading }
                    HStack(spacing: 12) { selectorRow }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: 12) {
                        leading
                        if !state.selectors.isEmpty {
                            groupDivider
                        }
                        selectorRow
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    // The scroll view itself inherits the chat screen's identifier, so the row carries the strip's.
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("composer-control-strip")
                }
                .scrollIndicators(.hidden)
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                .scrollDismissesKeyboard(.never)
                .onScrollGeometryChange(for: ComposerStripEdgeFades.self) { geometry in
                    ComposerStripEdgeFades(
                        contentOffset: geometry.contentOffset.x,
                        contentWidth: geometry.contentSize.width,
                        containerWidth: geometry.containerSize.width
                    )
                } action: { _, fades in
                    edgeFades = fades
                }
                .mask { edgeFadeMask }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // A material, not Liquid Glass: glass shapes in the composer's glass container melt into
        // the card, and the strip has to read as a separate piece hanging below it.
        .background(ComposerControlStrip.recessTint(for: colorScheme), in: stripShape)
        .background(.regularMaterial, in: stripShape)
        .overlay {
            ComposerStripBorder(cornerRadius: ComposerControlStrip.cornerRadius)
                .stroke(ComposerControlStrip.borderColor(for: colorScheme), lineWidth: 1)
        }
    }

    private var stripShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            bottomLeadingRadius: ComposerControlStrip.cornerRadius,
            bottomTrailingRadius: ComposerControlStrip.cornerRadius,
            style: .continuous
        )
    }

    /// Fades only an edge that hides controls, so the cut-off one reads as "scroll for more".
    private var edgeFadeMask: some View {
        HStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                .frame(width: edgeFades.leading ? edgeFadeWidth : 0)
            Rectangle()
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: edgeFades.trailing ? edgeFadeWidth : 0)
        }
    }

    private var edgeFadeWidth: CGFloat { 18 }

    private var groupDivider: some View {
        Rectangle()
            .fill(Color(.separator))
            .frame(width: 1, height: 14)
            .accessibilityHidden(true)
    }

    private var selectorRow: some View {
        ForEach(state.selectors, id: \.self) { selector in
            switch selector {
            case .workspace:
                ComposerWorkspaceSelectorButton(
                    title: state.workspaceTitle ?? "",
                    isDisabled: state.isDisabled,
                    color: .secondary,
                    controlFont: AppFont.footnote(),
                    chevronFont: AppFont.caption2(),
                    onTap: onChooseWorkspace
                )
            case .gitBranch:
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
            case .profile:
                ComposerProfileSelectorMenu(
                    profileOptions: state.profileOptions,
                    selectedProfileName: state.selectedProfileName,
                    selectedProfileTitle: state.selectedProfileTitle ?? "",
                    isDisabled: state.isDisabled,
                    color: .secondary,
                    controlFont: AppFont.footnote(),
                    chevronFont: AppFont.caption2(),
                    onSelectProfile: onSelectProfile
                )
            }
        }
    }
}

/// The strip's outline: both sides and the rounded bottom, open at the top where it meets the card.
struct ComposerStripBorder: Shape {
    let cornerRadius: CGFloat

    func path(in rect: CGRect) -> Path {
        let radius = min(cornerRadius, rect.width / 2, rect.height)
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - radius))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + radius, y: rect.maxY),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.maxX - radius, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: rect.maxY - radius),
            control: CGPoint(x: rect.maxX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
    }
}
