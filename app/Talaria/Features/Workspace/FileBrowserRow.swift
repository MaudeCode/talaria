import SwiftUI
import TalariaKit

struct FileBrowserRow: View {
    let entry: WorkspaceEntry
    let showsDisclosure: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: iconName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(iconColor)
                .frame(width: 26, height: 26)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(iconBackground)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(displayName)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)

                if let detailText {
                    Text(detailText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Spacer(minLength: 8)

            if showsDisclosure {
                Image(systemName: "chevron.forward")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private var displayName: String {
        let name = entry.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name, !name.isEmpty else {
            return String(localized: "Untitled")
        }
        return name
    }

    private var detailText: String? {
        if isDirectory {
            return entry.path
        }

        guard let size = entry.size else {
            return entry.path
        }

        return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }

    private var accessibilityLabel: String {
        let kind = isDirectory ? String(localized: "Folder") : String(localized: "File")
        if let detailText {
            return String(localized: "\(kind), \(displayName), \(detailText)")
        }
        return String(localized: "\(kind), \(displayName)")
    }

    private var isDirectory: Bool {
        entry.isBrowsableDirectory
    }

    private var iconName: String {
        isDirectory ? "folder" : "doc.text"
    }

    private var iconColor: Color {
        isDirectory ? .primary : .secondary
    }

    private var iconBackground: Color {
        isDirectory ? Color(.tertiarySystemFill) : Color(.secondarySystemFill)
    }
}
