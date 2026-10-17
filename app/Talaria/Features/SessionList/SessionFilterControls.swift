import SwiftUI
import TalariaKit

struct SessionFilterControls: View {
    let viewModel: SessionListViewModel
    let showsProfile: Bool
    let showsProjects: Bool
    @Binding var selectedProjectID: String?
    @Binding var projectPendingDeletion: ProjectSummary?
    @Binding var projectPendingRename: ProjectSummary?
    let switchActiveProfile: (ProfileSummary) -> Void
    let presentProjectCreation: () -> Void

    var body: some View {
        if showsProfileMenu || showsProjects {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    if showsProfileMenu {
                        profileMenu
                    }
                    if showsProjects {
                        projectMenu
                        if let pending = viewModel.pendingChanges["project:new"] {
                            SessionFilterChip(title: "\(pending.title ?? "") · \(pending.status)", systemImage: "folder")
                                .foregroundStyle(Color(hexString: pending.color) ?? .primary)
                        }
                    }
                }
                .padding(.horizontal, 24)
            }
            .padding(.top, 8)
            .sessionsScreenListRow()
        }
    }

    private var showsProfileMenu: Bool {
        showsProfile && !viewModel.isSingleProfileMode
    }

    private var profileMenu: some View {
        Menu {
            if viewModel.profileOptions.isEmpty {
                Text(viewModel.isLoadingActiveProfile ? "Loading profiles…" : "No profiles")
            } else {
                ForEach(viewModel.profileOptions) { profile in
                    let isActive = isActiveProfile(profile)
                    Button {
                        guard !isActive else { return }
                        switchActiveProfile(profile)
                    } label: {
                        Label(profile.displayName, systemImage: isActive ? "checkmark" : "person")
                    }
                    .disabled(
                        isActive
                            || viewModel.isViewingCachedData
                            || viewModel.isSwitchingActiveProfile
                            || profile.normalizedName == nil
                    )
                }
            }
        } label: {
            SessionFilterChip(
                title: viewModel.activeProfileDisplayName ?? String(localized: "Profile"),
                systemImage: "person.crop.circle"
            )
        }
        .accessibilityLabel("Active profile: \(viewModel.activeProfileDisplayName ?? String(localized: "Profile"))")
    }

    private var projectMenu: some View {
        Menu {
            Button {
                selectedProjectID = nil
            } label: {
                Label("All Projects", systemImage: selectedProjectID == nil ? "checkmark" : "tray.full")
            }

            ForEach(viewModel.projects) { project in
                if let projectID = project.projectId {
                    Button {
                        selectedProjectID = projectID
                    } label: {
                        Label(projectName(project), systemImage: selectedProjectID == projectID ? "checkmark" : "folder")
                            .foregroundStyle(Color(hexString: viewModel.pendingChange(for: project)?.color ?? project.color) ?? .primary)
                    }
                }
            }

            Divider()

            Button(action: presentProjectCreation) {
                Label("New Project", systemImage: "plus")
            }
            .disabled(viewModel.isViewingCachedData || viewModel.isCreatingProject)

            if let selectedProject {
                Menu("Selected Project") {
                    Button("Rename Project", systemImage: "pencil") {
                        projectPendingRename = selectedProject
                    }
                    Button("Delete Project", systemImage: "trash", role: .destructive) {
                        projectPendingDeletion = selectedProject
                    }
                }
                .disabled(viewModel.isViewingCachedData || viewModel.pendingChange(for: selectedProject) != nil)
            }
        } label: {
            SessionFilterChip(
                title: selectedProject.map(projectName) ?? String(localized: "All Projects"),
                systemImage: "folder"
            )
            .foregroundStyle(Color(hexString: selectedProject.flatMap { viewModel.pendingChange(for: $0)?.color }) ?? .primary)
        }
        .accessibilityLabel("Project filter: \(selectedProject.map(projectName) ?? String(localized: "All Projects"))")
    }

    private var selectedProject: ProjectSummary? {
        viewModel.projects.first { $0.projectId == selectedProjectID }
    }

    private func isActiveProfile(_ profile: ProfileSummary) -> Bool {
        guard let profileName = profile.normalizedName else { return false }
        return profileName == viewModel.activeProfileName || profile.isActive == true
    }

    private func projectName(_ project: ProjectSummary) -> String {
        if let pending = viewModel.pendingChange(for: project) {
            return "\(pending.title ?? project.name ?? "") · \(pending.status)"
        }
        guard let name = project.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return String(localized: "Untitled Project")
        }
        return name
    }
}
