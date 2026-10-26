import SwiftUI
import UIKit
import TalariaKit

struct SessionRowContextMenu: View {
    enum Placement {
        case menu, leadingSwipe, trailingSwipe, selection
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

        if placement != .leadingSwipe,
           placement == .selection || SessionRowActionPolicy.canArchive(session),
           placement == .menu || placement == .selection || isLiveServerSession {
            Button {
                actions.archive(session)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .disabled(
                placement == .selection
                    ? !viewModel.canPerformBulkAction(.archive) : !isLiveServerSession || isMutating
            )
            .frame(
                minWidth: placement == .selection ? 44 : nil, minHeight: placement == .selection ? 44 : nil
            )
            .tint(placement == .trailingSwipe ? .orange : nil)
        }

        if placement != .leadingSwipe,
           placement == .selection || SessionRowActionPolicy.canDelete(session),
           placement == .menu || placement == .selection || isLiveServerSession {
            Button(role: .destructive) {
                actions.delete(session)
            } label: {
                Label("Delete", systemImage: "trash")
            }
            .disabled(
                placement == .selection
                    ? !viewModel.canPerformBulkAction(.delete) : !isLiveServerSession || isMutating
            )
            .frame(
                minWidth: placement == .selection ? 44 : nil, minHeight: placement == .selection ? 44 : nil
            )
            .tint(placement == .trailingSwipe ? .red : nil)
        }
    }

    private var isLiveServerSession: Bool {
        !isViewingCachedData && hasServerSessionID(session)
    }

    private var canExportSession: Bool {
        SessionRowActionPolicy.canExport(session, isViewingCachedData: isViewingCachedData)
    }
}

extension EnvironmentValues {
    /// The list owns every session write, including chats created by the idle composer.
    @Entry var sessionActions: SessionRowContextMenu?
}
