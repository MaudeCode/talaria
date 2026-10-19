import SwiftUI
import TalariaKit

/// The messages waiting to send after the running reply, in full (TAL-630): each one can be sent now,
/// edited back in the composer, or removed, unless it is a steer the server may already hold. An owner chat's
/// queued and unknown-outcome inputs list here too, with only the actions the server offers (TAL-1043). The sheet
/// closes once both are empty; closing it changes nothing.
struct QueuedMessagesSheet: View {
    let previews: [QueuedMessagePreview]
    var admissions: [OwnerAdmission] = []
    /// False while offline or while an owner action awaits the server: the inputs show, but nothing can act on them.
    var canActOnAdmissions = true
    let onSendNow: (UUID) -> Void
    let onEdit: (UUID) -> Void
    let onRemove: (UUID) -> Void
    var onAdmissionAction: (OwnerAdmission.Action, OwnerAdmission) -> Void = { _, _ in }

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(admissions) { admission in
                    admissionCard(admission)
                }
                ForEach(Array(previews.enumerated()), id: \.element.id) { index, preview in
                    card(preview, position: index + 1)
                        .swipeActions(edge: .trailing) {
                            if preview.canChange {
                                Button(role: .destructive) { onRemove(preview.id) } label: {
                                    Label("Remove", systemImage: "trash")
                                }
                            }
                        }
                }
            }
            .navigationTitle(admissions.isEmpty ? String(localized: "Queued (\(previews.count))") : String(localized: "Agent inputs"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        // Initially too: the queue can drain between the chip's tap and the sheet appearing.
        .onChange(of: previews.isEmpty && admissions.isEmpty, initial: true) { _, isEmpty in
            if isEmpty { dismiss() }
        }
    }

    private func admissionCard(_ admission: OwnerAdmission) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(admission.isOutcomeUnknown ? String(localized: "Outcome unknown") : String(localized: "Queued"))
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(admission.isOutcomeUnknown ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))

            if let text = admission.text, !text.isEmpty {
                Text(text)
                    .font(AppFont.body())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }

            if !admission.actions.isEmpty {
                HStack(spacing: 20) {
                    ForEach(admission.actions, id: \.self) { action in
                        admissionButton(action, admission: admission)
                    }
                    Spacer(minLength: 0)
                }
                .buttonStyle(.borderless)
                .font(AppFont.subheadline(weight: .semibold))
                .labelStyle(.titleAndIcon)
                .frame(minHeight: 44)
                .disabled(!canActOnAdmissions)
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func admissionButton(_ action: OwnerAdmission.Action, admission: OwnerAdmission) -> some View {
        switch action {
        case .retry:
            Button { onAdmissionAction(.retry, admission) } label: {
                Label("Retry", systemImage: "arrow.clockwise")
            }
            .accessibilityHint(String(localized: "Puts the text back in the composer to review before sending"))
        case .discard:
            Button(role: .destructive) { onAdmissionAction(.discard, admission) } label: {
                Label("Discard", systemImage: "trash")
            }
        case .cancel:
            Button(role: .destructive) { onAdmissionAction(.cancel, admission) } label: {
                Label("Cancel", systemImage: "xmark")
            }
        }
    }

    private func card(_ preview: QueuedMessagePreview, position: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(position) of \(previews.count)")
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.secondary)

            if !preview.text.isEmpty {
                Text(preview.text)
                    .font(AppFont.body())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }

            // Two files can share a name, so the row's position is its identity.
            ForEach(Array(preview.attachmentNames.enumerated()), id: \.offset) { _, name in
                Label(name, systemImage: "paperclip")
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            if preview.canChange {
                HStack(spacing: 20) {
                    if preview.canSendNow {
                        Button { onSendNow(preview.id) } label: {
                            Label("Send now", systemImage: "arrow.up")
                        }
                    }
                    Button { onEdit(preview.id) } label: {
                        Label("Edit", systemImage: "pencil")
                    }
                    Spacer(minLength: 0)
                    Button(role: .destructive) { onRemove(preview.id) } label: {
                        Label("Remove", systemImage: "trash")
                    }
                }
                // Separate buttons in one row: a list row otherwise takes every tap as the row's.
                .buttonStyle(.borderless)
                .font(AppFont.subheadline(weight: .semibold))
                .labelStyle(.titleAndIcon)
                .frame(minHeight: 44)
            } else {
                Text("The server may already have this steer. If it doesn't, it sends after this reply.")
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
    }
}
