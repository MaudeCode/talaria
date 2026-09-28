import SwiftUI
import UIKit
import TalariaKit

struct ComposerAttachmentStripView: View {
    let attachments: [PendingAttachment]
    let onRemove: (UUID) -> Void
    let onPreview: (PendingAttachment) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if !attachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(attachments) { attachment in
                        ComposerAttachmentThumbnailView(
                            attachment: attachment,
                            onRemove: { onRemove(attachment.id) },
                            onOpen: { onPreview(attachment) }
                        )
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 4)
            }
            .frame(height: stripHeight)
        }
    }

    private var stripHeight: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 132 : 108
    }
}
