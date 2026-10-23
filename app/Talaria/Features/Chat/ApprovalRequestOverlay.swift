import SwiftUI
import UIKit
import TalariaKit

struct ApprovalRequestOverlay: View {
    let prompt: ApprovalPromptState
    let isResponding: Bool
    let errorMessage: String?
    let onChoice: (ApprovalChoice) -> Void
    let onSkipAll: () -> Void
    @Environment(\.layoutDirection) private var layoutDirection
    // Synthetic divisions let hosted tests exercise the same layout without device-pose state.
    var divisionFrames: [CGRect]? = nil

    var body: some View {
        ZStack {
            Color.black.opacity(0.38)
                .ignoresSafeArea()

            GeometryReader { geometry in
                let divisions = divisions(in: geometry)
                if divisions.isEmpty {
                    card { cardContent() }
                        .padding(.horizontal, 18)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    FoldAvoidingCardLayout(divisions: divisions, layoutDirection: layoutDirection) {
                        card {
                            ViewThatFits(in: .vertical) {
                                cardContent()
                                cardContent(scrollsDetails: true)
                            }
                        }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func cardContent(scrollsDetails: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if scrollsDetails {
                ScrollView { details }
            } else {
                details
            }
            actions
        }
    }

    private func divisions(in geometry: GeometryProxy) -> [CGRect] {
        if let divisionFrames { return divisionFrames }
        if #available(iOS 27.1, *) {
            return geometry.reservedRegions(kind: .division, layoutDirectionBehavior: .fixed)
                .filter(\.isActive).map(\.frame)
        }
        return []
    }

    static func cardFrame(in bounds: CGRect, divisions: [CGRect], cardSize: CGSize,
                          layoutDirection: LayoutDirection = .leftToRight) -> CGRect {
        let available = DivisionRegionLayout.availableFrame(in: bounds, divisions: divisions, layoutDirection: layoutDirection)
        guard !available.isNull else { return CGRect(origin: bounds.origin, size: .zero) }
        let width = min(520, max(0, available.width - 36))
        let height = min(cardSize.height, available.height)
        return CGRect(x: available.midX - width / 2, y: available.midY - height / 2, width: width, height: height)
    }

    private struct FoldAvoidingCardLayout: Layout {
        let divisions: [CGRect]
        let layoutDirection: LayoutDirection

        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
            proposal.replacingUnspecifiedDimensions()
        }

        func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
            guard let card = subviews.first else { return }
            let available = DivisionRegionLayout.availableFrame(in: bounds, divisions: divisions, layoutDirection: layoutDirection)
            guard !available.isNull else { return }
            let offeredFrame = ApprovalRequestOverlay.cardFrame(in: bounds, divisions: divisions,
                cardSize: available.size, layoutDirection: layoutDirection)
            let size = card.sizeThatFits(ProposedViewSize(width: offeredFrame.width, height: offeredFrame.height))
            let frame = ApprovalRequestOverlay.cardFrame(in: bounds, divisions: divisions, cardSize: size, layoutDirection: layoutDirection)
            card.place(at: CGPoint(x: frame.midX, y: frame.midY), anchor: .center,
                       proposal: ProposedViewSize(width: frame.width, height: frame.height))
        }
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(16)
            .frame(maxWidth: 520, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(.primary.opacity(0.10), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.22), radius: 18, x: 0, y: 12)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.yellow)

            VStack(alignment: .leading, spacing: 4) {
                Text("Approval required")
                    .font(.headline)

                Text("Pending approvals: \(prompt.pendingCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let description = nonEmpty(prompt.pending.description) {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let command = nonEmpty(prompt.pending.command) {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(command)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
            }

            if !prompt.patternKeys.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Pattern keys")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(prompt.patternKeys, id: \.self) { key in
                            Text(key)
                                .font(.caption2.monospaced())
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .background(Color(uiColor: .tertiarySystemBackground), in: Capsule())
                        }
                    }
                }
            }

            if prompt.pendingCount > 1 {
                Text("1 of \(prompt.pendingCount) pending")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let errorMessage = nonEmpty(errorMessage) {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private var actions: some View {
        VStack(spacing: 8) {
            // The approval's owner may accept fewer choices (TAL-1043); only those are offered.
            HStack(spacing: 8) {
                if prompt.pending.allows(.once) {
                    approvalButton("Allow once", systemImage: "checkmark.circle.fill", choice: .once, prominent: true)
                }
                if prompt.pending.allows(.session) {
                    approvalButton("Allow session", systemImage: "lock.open", choice: .session, prominent: false)
                }
            }

            HStack(spacing: 8) {
                if prompt.pending.allows(.always) {
                    approvalButton("Always allow", systemImage: "star.fill", choice: .always, prominent: false)
                }
                if prompt.pending.allows(.deny) {
                    approvalButton("Deny", systemImage: "xmark.circle.fill", choice: .deny, prominent: false, role: .destructive)
                }
            }

            if prompt.pending.allowsApprovalBypass {
                Button {
                    onSkipAll()
                } label: {
                    Label("Skip all this session", systemImage: "bolt.slash")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.chatDecision(.secondary))
                .disabled(isResponding)
            }
        }
    }

    @ViewBuilder
    private func approvalButton(
        _ title: String,
        systemImage: String,
        choice: ApprovalChoice,
        prominent: Bool,
        role: ButtonRole? = nil
    ) -> some View {
        if prominent {
            Button(role: role) {
                onChoice(choice)
            } label: {
                Label(title, systemImage: systemImage)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.chatDecision(.primary))
            .disabled(isResponding)
        } else {
            Button(role: role) {
                onChoice(choice)
            } label: {
                Label(title, systemImage: systemImage)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.chatDecision(role == .destructive ? .destructive : .secondary))
            .disabled(isResponding)
        }
    }

    private func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}
