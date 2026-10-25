import SwiftUI
import TalariaKit

struct SessionFilterControls: View {
    let viewModel: SessionListViewModel
    @Binding var selectedProjectID: String?
    @Binding var projectPendingDeletion: ProjectSummary?
    @Binding var projectPendingRename: ProjectSummary?
    let switchActiveProfile: (ProfileSummary) -> Void
    let presentProjectCreation: () -> Void

    var body: some View {
        Menu {
            if showsProfileMenu {
                Section("Profile") {
                    if viewModel.profileOptions.isEmpty {
                        Text(viewModel.isLoadingActiveProfile ? "Loading profiles…" : "No profiles")
                    } else {
                        ForEach(viewModel.profileOptions) { profile in
                            let isActive = isActiveProfile(profile)
                            Button { switchActiveProfile(profile) } label: {
                                Label(profile.displayName, systemImage: isActive ? "checkmark" : "person")
                            }
                            .accessibilityLabel(profileAccessibilityLabel(profile, isActive: isActive))
                            .disabled(isActive || viewModel.isViewingCachedData
                                || viewModel.isSwitchingActiveProfile || profile.normalizedName == nil)
                        }
                    }
                }
            }
            Section("Projects") {
                Button { selectedProjectID = nil } label: {
                    Label("All Projects", systemImage: selectedProjectID == nil ? "checkmark" : "tray.full")
                }
                ForEach(viewModel.projects) { project in
                    if let projectID = project.projectId {
                        let name = project.name?.trimmingCharacters(in: .whitespacesAndNewlines)
                        let displayName = name.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Untitled Project")
                        Button { selectedProjectID = projectID } label: {
                            Label(displayName, systemImage: selectedProjectID == projectID ? "checkmark" : "folder")
                        }
                        .accessibilityLabel(displayName)
                    }
                }
                Button(action: presentProjectCreation) {
                    Label("New Project", systemImage: "plus")
                }
                .disabled(viewModel.isViewingCachedData || viewModel.isCreatingProject)
                if let selectedProject {
                    Menu("Selected Project") {
                        Button("Rename Project", systemImage: "pencil") { projectPendingRename = selectedProject }
                        Button("Delete Project", systemImage: "trash", role: .destructive) { projectPendingDeletion = selectedProject }
                    }
                    .disabled(viewModel.isViewingCachedData || viewModel.pendingChange(for: selectedProject) != nil)
                }
            }
        } label: {
            Label("Filters", systemImage: hasActiveFilter
                ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                .font(.system(size: 20))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Filters")
        .accessibilityValue(hasActiveFilter ? "Filtered" : "All sessions")
    }

    private var hasActiveFilter: Bool {
        selectedProjectID != nil || viewModel.profileOptions.contains {
            isActiveProfile($0) && $0.isDefault == false
        }
    }

    private var showsProfileMenu: Bool {
        !viewModel.isSingleProfileMode
    }

    private var selectedProject: ProjectSummary? {
        viewModel.projects.first { $0.projectId == selectedProjectID }
    }

    private func profileAccessibilityLabel(_ profile: ProfileSummary, isActive: Bool) -> String {
        let model = profile.model?.trimmingCharacters(in: .whitespacesAndNewlines)
        let modelTitle = model.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Default model unavailable")
        let state = isActive ? String(localized: "Active profile") : String(localized: "Profile")
        let switchingState = viewModel.isSwitchingActiveProfile ? String(localized: ", switching in progress") : ""
        return String(localized: "\(state), \(profile.displayName), \(modelTitle)\(switchingState)")
    }

    private func isActiveProfile(_ profile: ProfileSummary) -> Bool {
        guard let profileName = profile.normalizedName else { return false }
        if let activeProfileName = viewModel.activeProfileName {
            return profileName == activeProfileName
        }
        return profile.isActive == true
    }

}
