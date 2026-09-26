import SwiftUI
import UIKit

struct SessionRowContextMenu: View {
    let session: SessionSummary
    let projects: [ProjectSummary]
    let isViewingCachedData: Bool
    let isRenamingSession: Bool
    let isCreatingProject: Bool
    let isMovingSession: Bool
    let isLoadingProjects: Bool
    let isMutating: Bool
    let actions: SessionListRowActions

    var body: some View {
        let fullTitle = SessionRowView.displayTitle(for: session)

        Section("Full Title") {
            Text(fullTitle)

            Button {
                UIPasteboard.general.string = fullTitle
            } label: {
                Label("Copy Full Title", systemImage: "doc.on.doc")
            }
        }

        if SessionRowActionPolicy.canPin(session) {
            Button {
                actions.togglePinned(session)
            } label: {
                Label(session.pinned == true ? "Unpin" : "Pin", systemImage: "pin")
            }
            .disabled(!isLiveServerSession || isMutating)
        }

        if SessionRowActionPolicy.canDuplicate(session) {
            Button {
                actions.duplicate(session)
            } label: {
                Label("Duplicate", systemImage: "doc.on.doc")
            }
            .disabled(isViewingCachedData || session.sessionId == nil || isMutating)
        }

        if SessionRowActionPolicy.offersMutationActions(for: session) {
            Button {
                actions.rename(session)
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            .disabled(isViewingCachedData || isRenamingSession || !hasServerSessionID(session))

            Menu {
                SessionProjectMoveMenu(
                    session: session,
                    projects: projects,
                    isCreatingProject: isCreatingProject,
                    isMovingSession: isMovingSession,
                    isLoadingProjects: isLoadingProjects,
                    actions: actions
                )
            } label: {
                Label("Move to Project", systemImage: "folder")
            }
            .disabled(isViewingCachedData || session.sessionId == nil || isMutating)
        }

        // Export works for any session the server can see, including read-only
        // and foreign/CLI rows; it only needs a live server session ID.
        Menu {
            Button {
                actions.export(session, .html)
            } label: {
                Label("Export as HTML", systemImage: "doc.richtext")
            }

            Button {
                actions.export(session, .json)
            } label: {
                Label("Export as JSON", systemImage: "curlybraces")
            }

            if let deepLinkURL = SessionRowActionPolicy.deepLinkURL(
                for: session,
                isViewingCachedData: isViewingCachedData,
                isMutating: isMutating
            ) {
                Button {
                    UIPasteboard.general.string = deepLinkURL.absoluteString
                } label: {
                    Label("Copy Deeplink", systemImage: "doc.on.doc")
                }
            }
        } label: {
            Label("Export", systemImage: "square.and.arrow.up")
        }
        .disabled(!canExportSession || isMutating)

        if SessionRowActionPolicy.canArchive(session) {
            Button {
                actions.archive(session)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .disabled(!isLiveServerSession || isMutating)
        }

        if SessionRowActionPolicy.offersMutationActions(for: session) {
            Button(role: .destructive) {
                actions.delete(session)
            } label: {
                Label("Delete", systemImage: "trash")
            }
            .disabled(!canShowSessionMutationActions || isMutating)
        }
    }

    private var canShowSessionMutationActions: Bool {
        SessionRowActionPolicy.offersMutationActions(for: session) && isLiveServerSession
    }

    private var isLiveServerSession: Bool {
        !isViewingCachedData && hasServerSessionID(session)
    }

    private var canExportSession: Bool {
        SessionRowActionPolicy.canExport(session, isViewingCachedData: isViewingCachedData)
    }
}
