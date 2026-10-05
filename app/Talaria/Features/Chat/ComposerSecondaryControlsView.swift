import SwiftUI
import UIKit
import TalariaKit

/// Web's `.composer-strip` measurements (TAL-629).
enum ComposerControlStrip {
    static let cornerRadius: CGFloat = 12
    /// Tall enough that each control's 44 pt hit area sits wholly inside the strip and below it,
    /// clear of the card above, which would otherwise take taps on its top edge.
    static let verticalPadding: CGFloat = 10
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

    let state: ComposerSecondaryControlsState
    let onChooseWorkspace: () -> Void
    let onSelectProfile: (ProfileSummary) -> Void
    let onSelectGitBranch: (GitCheckoutTarget) -> Void
    let onCreateGitBranch: (GitCheckoutTarget) -> Void
    let onRefreshGitBranches: () -> Void
    @ViewBuilder let leading: Leading

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                // Large text wraps the two groups onto their own lines instead of scrolling, spaced so
                // each row's hit shapes, which reach past its labels, never overlap the other row's.
                VStack(alignment: .leading, spacing: ComposerMetaControlLabel.hitPadding * 2) {
                    HStack(spacing: 12) { leading }
                    HStack(spacing: 12) { selectorRow }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, ComposerControlStrip.verticalPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ComposerStripScrollRow(accessibilityIdentifier: "composer-control-strip") {
                    HStack(spacing: 12) {
                        leading
                        if !state.selectors.isEmpty {
                            groupDivider
                        }
                        selectorRow
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, ComposerControlStrip.verticalPadding)
                }
            }
        }
        .composerStripChrome(hangingFrom: .bottom)
    }

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

/// A new chat's session as the composer shows it while the server creates it (TAL-636).
enum ComposerSessionStart: Equatable {
    case starting
    case failed(String)
}

/// The control strip while a new chat's session is starting: a spinner, or the error with Retry,
/// in place of the controls, which need the session.
struct ComposerSessionStartStrip: View {
    let state: ComposerSessionStart
    let onRetry: () -> Void

    var body: some View {
        // One footnote line, padded like the controls row, so the strip keeps its height when the
        // controls replace it; Retry's 44 pt target reaches past the line without taking space.
        HStack(spacing: 8) {
            switch state {
            case .starting:
                ProgressView()
                    .controlSize(.mini)
                Text("Starting chat…")
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
            case .failed(let message):
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(AppFont.footnote())
                    .foregroundStyle(.orange)
                Text(message)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button(action: onRetry) {
                    Text("Retry")
                        .font(AppFont.footnote().weight(.semibold))
                        .chatMinimumHitTarget(horizontalPadding: 12, verticalPadding: ComposerMetaControlLabel.hitPadding, in: Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 12)
        .padding(.vertical, ComposerControlStrip.verticalPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .composerStripChrome(hangingFrom: .bottom)
    }
}

/// Which edge of the composer card a strip hangs from: the controls hang below it, the pending
/// attachments above it (TAL-629, TAL-634).
enum ComposerStripEdge {
    case top
    case bottom
}

extension View {
    /// A strip's panel: a material a shade back from the card (not Liquid Glass, whose shapes melt
    /// into the card's), rounded on its free edge and outlined everywhere but the card side.
    func composerStripChrome(hangingFrom edge: ComposerStripEdge) -> some View {
        modifier(ComposerStripChrome(edge: edge))
    }
}

private struct ComposerStripChrome: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let edge: ComposerStripEdge

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ComposerControlStrip.recessTint(for: colorScheme), in: shape)
            .background(.regularMaterial, in: shape)
            .overlay {
                ComposerStripBorder(cornerRadius: ComposerControlStrip.cornerRadius, edge: edge)
                    .stroke(ComposerControlStrip.borderColor(for: colorScheme), lineWidth: 1)
            }
    }

    private var shape: UnevenRoundedRectangle {
        let radius = ComposerControlStrip.cornerRadius
        return edge == .bottom
            ? UnevenRoundedRectangle(bottomLeadingRadius: radius, bottomTrailingRadius: radius, style: .continuous)
            : UnevenRoundedRectangle(topLeadingRadius: radius, topTrailingRadius: radius, style: .continuous)
    }
}

/// A strip's horizontally scrolling row, fading only an edge that hides content so the cut-off one
/// reads as "scroll for more".
struct ComposerStripScrollRow<Content: View>: View {
    let accessibilityIdentifier: String
    @ViewBuilder let content: Content

    @State private var edgeFades = ComposerStripEdgeFades(leading: false, trailing: false)

    var body: some View {
        ScrollView(.horizontal) {
            content
                // The scroll view itself inherits the chat screen's identifier, so the row carries the strip's.
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(accessibilityIdentifier)
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
        .mask {
            HStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                    .frame(width: edgeFades.leading ? edgeFadeWidth : 0)
                Rectangle()
                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: edgeFades.trailing ? edgeFadeWidth : 0)
            }
        }
    }

    private var edgeFadeWidth: CGFloat { 18 }
}

/// A strip's outline: both sides and the rounded free edge, open where it meets the card.
struct ComposerStripBorder: Shape {
    let cornerRadius: CGFloat
    var edge: ComposerStripEdge = .bottom

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
        guard edge == .top else { return path }
        // Hanging above the card: the same outline, flipped so it opens at the bottom.
        return path.applying(CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: rect.minY + rect.maxY))
    }
}
