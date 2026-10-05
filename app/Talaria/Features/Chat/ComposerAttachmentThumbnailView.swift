import SwiftUI
import UIKit
import TalariaKit

/// A pending photo in the composer's attachment strip (TAL-634): just its thumbnail, which opens the
/// preview, with a small remove badge on the corner. No name and no background of its own.
struct ComposerAttachmentThumbnailView: View {
    let attachment: PendingAttachment
    let onRemove: () -> Void
    let onOpen: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        Button(action: onOpen) {
            thumbnail
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open attachment \(attachment.name)")
        .overlay(alignment: .topTrailing) {
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Color(.label))
                    .frame(width: 16, height: 16)
                    .background(Circle().fill(Color(.systemBackground)))
                    .overlay(Circle().stroke(Color(.separator).opacity(0.4), lineWidth: 0.5))
                    .chatMinimumHitTarget(horizontalPadding: 14, verticalPadding: 14, in: Rectangle())
            }
            .buttonStyle(.plain)
            .offset(x: RTLLayout.horizontalOffset(5, isRightToLeft: layoutDirection == .rightToLeft), y: -5)
            .accessibilityLabel("Remove attachment \(attachment.name)")
        }
        // The badge pokes past the corner; the padding keeps it inside the strip.
        .padding(.top, 5)
        .padding(.trailing, 5)
    }

    private var thumbnail: some View {
        Group {
            if let thumbnailData = attachment.thumbnailData, let uiImage = UIImage(data: thumbnailData) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
            } else {
                Color(.systemFill)
                    .overlay(
                        Image(systemName: "photo")
                            .font(.system(size: thumbnailSize * 0.38))
                            .foregroundStyle(Color(.tertiaryLabel))
                    )
            }
        }
        .frame(width: thumbnailSize, height: thumbnailSize)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(Color(.separator).opacity(0.25), lineWidth: 0.5)
        )
    }

    private var thumbnailSize: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 56 : 44
    }
}

/// A pending file inside the composer card, above the text (TAL-634): a link-styled name, like a
/// T3 Code file link, that opens its preview, and a remove button. It still sends as an attachment.
struct ComposerFileLinkView: View {
    let attachment: PendingAttachment
    let onRemove: () -> Void
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onOpen) {
                Label {
                    Text(attachment.name)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } icon: {
                    Image(systemName: "paperclip")
                }
                .font(AppFont.subheadline())
                .foregroundStyle(.tint)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open attachment \(attachment.name)")

            // The remove target takes its full 44 pt in layout, so it never overlaps the link's.
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove attachment \(attachment.name)")
        }
        // A full 44 pt row holds the remove button, so stacked links never share a target.
        .frame(minHeight: 44)
        .fixedSize(horizontal: false, vertical: true)
    }
}
