import SwiftUI
import TalariaKit

struct SessionProjectMoveMenu: View {
    let session: SessionSummary
    let projects: [ProjectSummary]
    let isCreatingProject: Bool
    let isMovingSession: Bool
    let isLoadingProjects: Bool
    let actions: SessionListRowActions

    var body: some View {
        Button {
            actions.move(session, nil)
        } label: {
            Label("No project", systemImage: session.projectId == nil ? "checkmark" : "tray")
        }
        .disabled(isMovingSession || session.projectId == nil)

        if !projects.isEmpty {
            Divider()

            ForEach(projects) { project in
                let projectID = project.projectId
                let isSelected = session.projectId == projectID
                let projectName = project.name.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Untitled Project")

                Button {
                    actions.move(session, projectID)
                } label: {
                    Label(
                        projectName,
                        systemImage: isSelected ? "checkmark" : "folder"
                    )
                }
                .disabled(isMovingSession || projectID == nil || isSelected)
            }
        }

        Divider()

        Button {
            actions.createProject(session)
        } label: {
            Label("New Project", systemImage: "folder.badge.plus")
        }
        .disabled(isCreatingProject || isMovingSession)

        if projects.isEmpty {
            Button {
                actions.refreshProjects()
            } label: {
                Label("Refresh Projects", systemImage: "arrow.clockwise")
            }
            .disabled(isLoadingProjects)
        }
    }
}
