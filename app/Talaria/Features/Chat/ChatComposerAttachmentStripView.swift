import SwiftUI
import UIKit
import TalariaKit

/// Pending photos in a strip hanging from the composer card's top edge, the mirror of the control
/// strip under it (TAL-634). The strip is the only background; each photo is just its thumbnail.
/// Files go inside the card as links instead (`ComposerFileLinkView`).
/// The feedback form (TAL-1597) shows the same strip as a plain form row.
struct ComposerAttachmentStripView: View {
    let photos: [PendingAttachment]
    /// False inside a form row, where the strip has no panel of its own.
    var hangsFromCard = true
    let onRemove: (UUID) -> Void
    let onPreview: ((PendingAttachment) -> Void)?

    var body: some View {
        let row = ComposerStripScrollRow(accessibilityIdentifier: "composer-attachment-strip") {
            HStack(spacing: 10) {
                ForEach(photos) { photo in
                    ComposerAttachmentThumbnailView(
                        attachment: photo,
                        onRemove: { onRemove(photo.id) },
                        onOpen: onPreview.map { preview in { preview(photo) } }
                    )
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        if hangsFromCard { row.composerStripChrome(hangingFrom: .top) } else { row }
    }
}
