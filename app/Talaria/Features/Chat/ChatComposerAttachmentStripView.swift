import SwiftUI
import UIKit
import TalariaKit

/// Pending attachments in a strip hanging from the composer card's top edge, the mirror of the
/// control strip under it (TAL-634). The strip is the only background; each attachment is a plain chip.
struct ComposerAttachmentStripView: View {
    let attachments: [PendingAttachment]
    let onRemove: (UUID) -> Void
    let onPreview: (PendingAttachment) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                // Large text stacks the chips instead of scrolling them.
                VStack(alignment: .leading, spacing: 0) { chips }
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ComposerStripScrollRow(accessibilityIdentifier: "composer-attachment-strip") {
                    HStack(spacing: 14) { chips }
                        .padding(.horizontal, 10)
                }
            }
        }
        .composerStripChrome(hangingFrom: .top)
    }

    private var chips: some View {
        ForEach(attachments) { attachment in
            ComposerAttachmentThumbnailView(
                attachment: attachment,
                onRemove: { onRemove(attachment.id) },
                onOpen: { onPreview(attachment) }
            )
        }
    }
}
