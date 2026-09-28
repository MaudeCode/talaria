import SwiftUI
import TalariaKit

struct GridAttachmentCell: View {
    let attachment: MessageAttachment
    let cacheNamespace: String
    let localData: Data?
    let loadAttachmentImage: ((String) async -> Data?)?
    let onPreviewAttachment: ((MessageAttachment, Data?) -> Void)?
    let size: CGFloat

    private var resolvedPath: String? {
        // The server saves uploads to the workspace root. Use the explicit
        // path when available; for older sessions fall back to filename.
        if let path = attachment.path, !path.isEmpty { return path }
        if let name = attachment.name, !name.isEmpty { return name }
        return nil
    }

    var body: some View {
        if let onPreviewAttachment {
            Button {
                onPreviewAttachment(attachment, localData)
            } label: {
                cellContent
            }
            .buttonStyle(.chatTactile(.thumbnail))
            .accessibilityLabel("Open attachment \(fileDisplayName)")
        } else {
            cellContent
        }
    }

    @ViewBuilder
    private var cellContent: some View {
        if inferredIsImage {
            imageCell
        } else {
            fileCell
        }
    }

    private var inferredIsImage: Bool {
        // Explicit server flag is the strongest signal.
        if attachment.isImage == true { return true }

        // Fall back to MIME type (e.g. "image/jpeg").
        if let mime = attachment.mime?.lowercased(), mime.hasPrefix("image/") { return true }

        // Fall back to file extension for older sessions where the server
        // did not persist `is_image`.
        let ext = URL(fileURLWithPath: attachment.name ?? resolvedPath ?? "").pathExtension.lowercased()
        return ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif"].contains(ext)
    }

    @ViewBuilder
    private var imageCell: some View {
        ZStack {
            if let localData, let uiImage = UIImage(data: localData) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipped()
            } else if let path = resolvedPath, let loadAttachmentImage {
                RemoteAttachmentImage(
                    path: path,
                    cacheNamespace: cacheNamespace,
                    loadAttachmentImage: loadAttachmentImage
                )
                .frame(width: size, height: size)
                .clipped()
            } else {
                fallbackImage
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(.separator).opacity(0.25), lineWidth: 0.5)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Image attachment \(attachmentAccessibilityName)")
    }

    private var fileCell: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(.secondarySystemBackground))

            VStack(spacing: 5) {
                Image(systemName: fileIconName)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(fileBadgeColor)

                Text(fileDisplayName)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(Color(.label))
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .truncationMode(.middle)
                    .frame(maxWidth: size - 18)

                Text(fileExtensionLabel)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(fileBadgeColor)
                    .lineLimit(1)
            }
        }
        .frame(width: size, height: size)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(.separator).opacity(0.25), lineWidth: 0.5)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("File attachment \(fileDisplayName), \(fileExtensionLabel)")
    }

    private var fallbackImage: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color(.systemFill))
            .overlay(
                Image(systemName: "photo")
                    .font(.system(size: 34, weight: .regular))
                    .foregroundStyle(Color(.tertiaryLabel))
            )
    }

    private var placeholderImage: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color(.systemFill))
            .overlay(
                ProgressView()
                    .tint(Color(.tertiaryLabel))
            )
    }

    private var fileExtensionLabel: String {
        let ext = URL(fileURLWithPath: attachment.name ?? "").pathExtension.uppercased()
        return ext.isEmpty ? String(localized: "FILE") : String(ext.prefix(5))
    }

    private var fileDisplayName: String {
        if let name = attachment.name?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty {
            return name
        }

        if let path = attachment.path?.trimmingCharacters(in: .whitespacesAndNewlines),
           !path.isEmpty {
            let lastPathComponent = URL(fileURLWithPath: path).lastPathComponent
            return lastPathComponent.isEmpty ? path : lastPathComponent
        }

        return String(localized: "File")
    }

    private var attachmentAccessibilityName: String {
        fileDisplayName == String(localized: "File") ? String(localized: "image") : fileDisplayName
    }

    private var fileIconName: String {
        switch URL(fileURLWithPath: attachment.name ?? "").pathExtension.lowercased() {
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
        switch URL(fileURLWithPath: attachment.name ?? "").pathExtension.lowercased() {
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
}
