import SwiftUI
import UIKit
import TalariaKit

struct SessionRowContextMenu: View {
    enum Placement {
        case menu, leadingSwipe, trailingSwipe
    }

    let viewModel: SessionListViewModel
    let session: SessionSummary
    let actions: SessionListRowActions
    var placement: Placement = .menu

    private var isViewingCachedData: Bool { viewModel.isViewingCachedData }
    private var isMutating: Bool { viewModel.isMutating(session) }
    private var pendingChange: PendingResourceChange? { viewModel.pendingChange(for: session) }

    var body: some View {
        let fullTitle = pendingChange?.title ?? SessionRowPresentation.displayTitle(for: session)

        if placement == .menu {
            Section("Full Title") {
                Text(fullTitle)

                Button {
                    UIPasteboard.general.string = fullTitle
                } label: {
                    Label("Copy Full Title", systemImage: "doc.on.doc")
                }
            }
        }

        if (placement == .menu || placement == .leadingSwipe), SessionRowActionPolicy.canPin(session),
           placement == .menu || isLiveServerSession {
            Button {
                actions.togglePinned(session)
            } label: {
                Label((pendingChange?.pinned ?? session.pinned) == true ? "Unpin" : "Pin", systemImage: "pin")
            }
            .disabled(!isLiveServerSession || isMutating)
            .tint(placement == .leadingSwipe ? .accentColor : nil)
        }

        if placement == .menu {
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
                .disabled(isViewingCachedData || isMutating || !hasServerSessionID(session))

                Menu {
                    SessionProjectMoveMenu(
                        session: session,
                        projects: viewModel.projects,
                        isCreatingProject: viewModel.isCreatingProject,
                        isMovingSession: isMutating,
                        isLoadingProjects: viewModel.isLoadingProjects,
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
        }

        if placement != .leadingSwipe, placement == .menu || isLiveServerSession {
            SessionRemovalButtons(
                isDisabled: { _ in !isLiveServerSession || isMutating },
                archive: SessionRowActionPolicy.canArchive(session) ? { actions.archive(session) } : nil,
                delete: SessionRowActionPolicy.canDelete(session) ? { actions.delete(session) } : nil,
                isSwipe: placement == .trailingSwipe
            )
        }
    }

    private var isLiveServerSession: Bool {
        !isViewingCachedData && hasServerSessionID(session)
    }

    private var canExportSession: Bool {
        SessionRowActionPolicy.canExport(session, isViewingCachedData: isViewingCachedData)
    }
}

/// The removal labels are shared by individual session actions and the selection bar.
struct SessionRemovalButtons: View {
    let isDisabled: (SessionBulkAction) -> Bool
    let archive: (() -> Void)?
    let delete: (() -> Void)?
    var isSwipe = false

    var body: some View {
        if let archive {
            Button(action: archive) {
                Label("Archive", systemImage: "archivebox")
            }
            .disabled(isDisabled(.archive))
            .tint(isSwipe ? .orange : nil)
        }
        if let delete {
            // A destructive swipe removes the row before its confirmation alert is answered.
            Button(role: isSwipe ? nil : .destructive, action: delete) {
                Label("Delete", systemImage: "trash")
            }
            .disabled(isDisabled(.delete))
            .tint(isSwipe ? .red : nil)
        }
    }
}

/// Data for the current chat's menu, using the list's stable mutation owner.
struct SessionActionContext: Equatable {
    let session: SessionSummary
    let viewModel: SessionListViewModel
    let actions: SessionListRowActions

    static func == (lhs: Self, rhs: Self) -> Bool {
        // The same list owner supplies the same handlers across list refreshes.
        lhs.session == rhs.session && lhs.viewModel === rhs.viewModel
    }
}

extension EnvironmentValues {
    /// The current chat's session and list-owned handlers; the chat builds its own menu.
    @Entry var sessionActions: SessionActionContext?
}
