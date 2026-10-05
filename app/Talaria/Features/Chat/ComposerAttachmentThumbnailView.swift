import SwiftUI
import UIKit
import TalariaKit

/// One pending attachment in the composer's attachment strip (TAL-634): a small thumbnail and the
/// file name, which open its preview, and a remove button. No background of its own.
struct ComposerAttachmentThumbnailView: View {
    let attachment: PendingAttachment
    let onRemove: () -> Void
    let onOpen: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 6) {
            Button(action: onOpen) {
                HStack(spacing: 8) {
                    thumbnail
                    Text(attachment.name)
                        .font(AppFont.footnote())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: usesAccessibilityLayout ? 220 : 120, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open attachment \(attachment.name)")

            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, height: 18)
                    .chatMinimumHitTarget(horizontalPadding: 13, verticalPadding: 13, in: Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove attachment \(attachment.name)")
        }
        // A full 44 pt row holds the remove button's hit area, so stacked chips never share one.
        .frame(minHeight: 44)
        // Size to the name (capped above) instead of stretching to whatever width is offered.
        .fixedSize(horizontal: true, vertical: false)
    }

    @ViewBuilder
    private var thumbnail: some View {
        Group {
            if attachment.isImage, let thumbnailData = attachment.thumbnailData, let uiImage = UIImage(data: thumbnailData) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
            } else if attachment.isImage {
                Color(.systemFill)
                    .overlay(
                        Image(systemName: "photo")
                            .font(.system(size: thumbnailSize * 0.42))
                            .foregroundStyle(Color(.tertiaryLabel))
                    )
            } else {
                fileBadgeColor.opacity(0.15)
                    .overlay(
                        Image(systemName: fileIconName)
                            .font(.system(size: thumbnailSize * 0.42, weight: .semibold))
                            .foregroundStyle(fileBadgeColor)
                    )
            }
        }
        .frame(width: thumbnailSize, height: thumbnailSize)
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(Color(.separator).opacity(0.25), lineWidth: 0.5)
        )
        .accessibilityHidden(true)
    }

    private var thumbnailSize: CGFloat {
        usesAccessibilityLayout ? 40 : 32
    }

    private var fileIconName: String {
        switch URL(fileURLWithPath: attachment.name).pathExtension.lowercased() {
        case "csv", "tsv", "xls", "xlsx":
            "tablecells"
        case "json", "md", "txt", "log", "xml", "yaml", "yml":
            "doc.text"
        case "pdf":
            "doc.richtext"
        case "zip", "tar", "gz", "tgz":
            "archivebox"
        default:
            "doc"
        }
    }

    private var fileBadgeColor: Color {
        switch URL(fileURLWithPath: attachment.name).pathExtension.lowercased() {
        case "csv", "tsv", "xls", "xlsx":
            Color.green
        case "pdf":
            Color.red
        case "json", "md", "txt", "log", "xml", "yaml", "yml":
            Color.blue
        default:
            Color.accentColor
        }
    }

    private var usesAccessibilityLayout: Bool {
        dynamicTypeSize.isAccessibilitySize
    }
}
