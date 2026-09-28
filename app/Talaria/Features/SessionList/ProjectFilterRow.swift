import SwiftUI
import TalariaKit

struct ProjectFilterRow: View {
    let project: ProjectSummary
    let isSelected: Bool
    let count: Int
    let isViewingCachedData: Bool
    let isRenamingProject: Bool
    let isDeletingProject: Bool
    let action: () -> Void
    let rename: () -> Void
    let delete: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: action) {
                HStack(spacing: 18) {
                    SidebarUtilityIcon(assetImage: "LucideFolder", tint: projectColor)

                    Text(displayName)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Spacer(minLength: 0)

                    HStack(spacing: 8) {
                        if count > 0 {
                            Text("\(count)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }

                        if isSelected {
                            SidebarSelectedSubrowIndicator()
                        }
                    }
                }
                .padding(.leading, 18)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(displayName)
            .accessibilityValue(accessibilityValue)
            .accessibilityHint(isSelected ? "Clears this project filter." : "Filters sessions to this project.")

            Menu {
                Button {
                    rename()
                } label: {
                    Label("Rename Project", systemImage: "pencil")
                }
                .disabled(projectActionsAreDisabled)

                Button(role: .destructive) {
                    delete()
                } label: {
                    Label("Delete Project", systemImage: "trash")
                }
                .disabled(projectActionsAreDisabled)
            } label: {
                Label(String(localized: "Project actions for \(displayName)"), systemImage: "ellipsis")
                    .labelStyle(.iconOnly)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(String(localized: "Project actions for \(displayName)"))
            .accessibilityHint("Shows rename and delete actions for this project.")
        }
        .background {
            if isSelected {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.accentColor.opacity(0.10))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Color.accentColor.opacity(0.20), lineWidth: 1)
                    }
            }
        }
    }

    private var displayName: String {
        let name = project.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name, !name.isEmpty else {
            return String(localized: "Untitled Project")
        }
        return name
    }

    private var accessibilityValue: String {
        let countTitle = String(localized: "\(count) sessions")
        return isSelected ? String(localized: "Selected, \(countTitle)") : countTitle
    }

    private var projectActionsAreDisabled: Bool {
        isViewingCachedData
            || isRenamingProject
            || isDeletingProject
            || project.projectId == nil
    }

    private var projectColor: Color {
        if let apiColor = Color(hexString: project.color) {
            return apiColor
        }

        switch stableColorSeed % 5 {
        case 0: return .green
        case 1: return .blue
        case 2: return .red
        case 3: return .orange
        default: return .primary
        }
    }

    private var stableColorSeed: Int {
        let source = project.projectId ?? displayName
        return source.unicodeScalars.reduce(0) { partialResult, scalar in
            partialResult &+ Int(scalar.value)
        }
    }
}
