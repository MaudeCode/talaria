import SwiftUI
import TalariaKit

/// The messages waiting to send after the running reply, in full (TAL-630): each one can be sent now,
/// edited back in the composer, or removed. The sheet closes once the queue is empty.
struct QueuedMessagesSheet: View {
    let previews: [QueuedMessagePreview]
    let onSendNow: (UUID) -> Void
    let onEdit: (UUID) -> Void
    let onRemove: (UUID) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(previews.enumerated()), id: \.element.id) { index, preview in
                    card(preview, position: index + 1)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { onRemove(preview.id) } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                }
            }
            .navigationTitle("Queued (\(previews.count))")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onChange(of: previews.isEmpty) { _, isEmpty in
            if isEmpty { dismiss() }
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

            ForEach(preview.attachmentNames, id: \.self) { name in
                Label(name, systemImage: "paperclip")
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

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
        }
        .padding(.vertical, 6)
    }
}
