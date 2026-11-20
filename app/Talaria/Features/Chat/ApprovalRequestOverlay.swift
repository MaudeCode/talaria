import SwiftUI
import UIKit
import TalariaKit

/// TAL-2021: an approval waits in the composer's question slot, like a clarification, so the transcript above stays
/// readable and scrollable; the chevron folds it into the "Approval needed" chip above the composer.
struct ApprovalRequestContent: View {
    let prompt: ApprovalPromptState
    let isResponding: Bool
    let errorMessage: String?
    let onChoice: (ApprovalChoice) -> Void
    let onSkipAll: () -> Void
    let onCollapse: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // The slot's height is capped, so the whole card scrolls: at large text sizes the last choice scrolls into view.
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                details
                actions
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .frame(maxWidth: 560, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    /// Sits on the slot's resize handle row, so it takes none of the card's height.
    var collapseButton: some View {
        Button(action: onCollapse) {
            Image(systemName: "chevron.down")
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Collapse approval")
    }

    /// TAL-2333: the held call's arguments as its tool row shows them; a shell call has none and shows its command.
    private var toolArguments: [ToolCallArgumentDisplay] {
        prompt.pending.tool.map { ToolCallDisplayFormatter.content(for: $0).argumentRows } ?? []
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            // TAL-2333: the held call's icon and label, as its tool row shows them.
            if let tool = prompt.pending.tool {
                ToolActivityIcon(name: AssistantActivitySummary.icon(for: tool), logoURL: tool.app?.logoURL)
                    .foregroundStyle(.yellow)
                    .frame(width: 16, height: 16)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.yellow)
            }

            VStack(alignment: .leading, spacing: 4) {
                Group {
                    if let tool = prompt.pending.tool {
                        Text(AssistantActivitySummary.label(for: tool))
                            .lineLimit(2)
                            .accessibilityLabel(String(localized: "Approval required: \(AssistantActivitySummary.label(for: tool))"))
                    } else {
                        Text("Approval required")
                    }
                }
                .font(.headline)
                .accessibilityAddTraits(.isHeader)

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

            if !toolArguments.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(toolArguments) { ToolArgumentRow(row: $0) }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("approval-tool-arguments")
            } else if let command = nonEmpty(prompt.pending.command) {
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
        // Accessibility text sizes stack each pair, so no choice wraps a letter per line.
        let pair = dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
        return VStack(spacing: 8) {
            // The approval's owner may accept fewer choices (TAL-1043); only those are offered, and none may be (TAL-1414).
            if ApprovalChoice.allCases.contains(where: prompt.pending.allows) {
                pair {
                    if prompt.pending.allows(.once) {
                        approvalButton("Allow once", systemImage: "checkmark.circle.fill", choice: .once, prominent: true)
                    }
                    if prompt.pending.allows(.session) {
                        approvalButton("Allow session", systemImage: "lock.open", choice: .session, prominent: false)
                    }
                }

                pair {
                    if prompt.pending.allows(.always) {
                        approvalButton("Always allow", systemImage: "star.fill", choice: .always, prominent: false)
                    }
                    if prompt.pending.allows(.deny) {
                        approvalButton("Deny", systemImage: "xmark.circle.fill", choice: .deny, prominent: false, role: .destructive)
                    }
                }
            } else {
                Text("This approval can't be answered here.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
