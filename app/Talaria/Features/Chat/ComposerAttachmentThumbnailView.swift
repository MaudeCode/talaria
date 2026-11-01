import SwiftUI
import UIKit
import TalariaKit

/// A pending photo in the composer's attachment strip (TAL-634): just its thumbnail, which opens the
/// preview, with a small remove badge on the corner. No name and no background of its own.
struct ComposerAttachmentThumbnailView: View {
    let attachment: PendingAttachment
    let onRemove: () -> Void
    /// Nil when there is no preview to open.
    let onOpen: (() -> Void)?

    @Environment(\.retryPendingAttachment) private var retry
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        Button {
            if case .failed = attachment.uploadPhase { retry(attachment.id) } else { onOpen?() }
        } label: {
            thumbnail
        }
        .buttonStyle(.plain)
        .disabled(attachment.uploadPhase == .staged || attachment.uploadPhase == .uploading)
        .overlay(alignment: .bottom) { ComposerAttachmentUploadStatus(attachment: attachment).allowsHitTesting(false).accessibilityHidden(true) }
        .accessibilityLabel(photoActionLabel)
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

    private var photoActionLabel: String {
        switch attachment.uploadPhase {
        case .failed(let error): return String(localized: "Retry upload \(attachment.name). \(error)")
        case .staged, .uploading: return String(localized: "Uploading \(attachment.name)")
        case .ready: return onOpen == nil ? attachment.name : String(localized: "Open attachment \(attachment.name)")
        }
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
            .disabled(!attachment.isReadyToSend)
            .accessibilityLabel("Open attachment \(attachment.name)")

            if case .failed(let error) = attachment.uploadPhase {
                Text(error).font(AppFont.footnote()).foregroundStyle(.secondary).lineLimit(2).padding(.leading, 8)
            }
            ComposerAttachmentUploadStatus(attachment: attachment)

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

/// Both file links and photo thumbnails use the same per-item upload and retry presentation.
struct ComposerAttachmentUploadStatus: View {
    let attachment: PendingAttachment
    @Environment(\.retryPendingAttachment) private var retry

    var body: some View {
        switch attachment.uploadPhase {
        case .ready: EmptyView()
        case .staged, .uploading:
            ProgressView().controlSize(.small)
                .accessibilityLabel("Uploading \(attachment.name)")
        case .failed(let error):
            Button { retry(attachment.id) } label: {
                Image(systemName: "arrow.clockwise.circle.fill")
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Retry upload \(attachment.name)")
            .accessibilityHint(error)
        }
    }
}

private struct RetryPendingAttachmentKey: EnvironmentKey {
    static let defaultValue: (UUID) -> Void = { _ in }
}
extension EnvironmentValues {
    var retryPendingAttachment: (UUID) -> Void {
        get { self[RetryPendingAttachmentKey.self] }
        set { self[RetryPendingAttachmentKey.self] = newValue }
    }
}
