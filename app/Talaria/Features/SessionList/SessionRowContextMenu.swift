import SwiftUI
import SwiftData
import UIKit
import TalariaKit

struct SessionRowContextMenu: View {
    enum Placement {
        case menu, leadingSwipe, trailingSwipe
    }

    let viewModel: SessionListViewModel
    private let originalSession: SessionSummary
    let actions: SessionListRowActions
    var placement: Placement = .menu
    var openBeside: (() -> Void)?
    var openInNewWindow: (() -> Void)?
    /// A list row hands over its current session and its own state; the chat's menu, given none, reads them from the list.
    private let rowState: (pendingChange: PendingResourceChange?, isMutating: Bool)?

    init(viewModel: SessionListViewModel, session: SessionSummary, actions: SessionListRowActions, placement: Placement = .menu,
         openBeside: (() -> Void)? = nil, openInNewWindow: (() -> Void)? = nil, rowState: (pendingChange: PendingResourceChange?, isMutating: Bool)? = nil) {
        self.viewModel = viewModel
        originalSession = session
        self.actions = actions
        self.placement = placement
        self.openBeside = openBeside
        self.openInNewWindow = openInNewWindow
        self.rowState = rowState
    }

    // Menu metadata observes list updates here, without invalidating the enclosing chat body.
    private var session: SessionSummary {
        guard rowState == nil else { return originalSession }
        return viewModel.sessions.first { $0.sessionId == originalSession.sessionId } ?? originalSession
    }

    private var isViewingCachedData: Bool { viewModel.isViewingCachedData }
    private var isMutating: Bool { rowState?.isMutating ?? viewModel.isMutating(session) }
    private var pendingChange: PendingResourceChange? {
        if let rowState { return rowState.pendingChange }
        return viewModel.pendingChange(for: session)
    }

    var body: some View {
        let session = self.session
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
            windowButtons
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
                    SessionProjectMoveMenu(viewModel: viewModel, session: session, isMovingSession: isMutating, actions: actions)
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

    @ViewBuilder
    var windowButtons: some View {
        if let openBeside {
            Button(action: openBeside) { Label("Open Beside", systemImage: "rectangle.split.2x1") }
        }
        if let openInNewWindow { OpenInNewWindowButton(action: openInNewWindow) }
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

/// List-owned handlers shared by every chat, including locally pushed forks.
final class SessionActionContext {
    let viewModel: SessionListViewModel
    let actions: SessionListRowActions
    /// The section lists' handlers, built once per list so their rows keep one set; only `open` differs from `actions`.
    private var sectionActions: [AppSection: SessionListRowActions] = [:]
    let onAPIError: (Error) -> Void
    let filesInspector: SplitFilesInspector
    var modelContext: ModelContext?
    var layoutDirection: LayoutDirection = .leftToRight
    var reduceMotion = false
    var scenePhase: ScenePhase = .inactive
    var horizontalSizeClass: UserInterfaceSizeClass?
    var verticalSizeClass: UserInterfaceSizeClass?

    init(viewModel: SessionListViewModel, actions: SessionListRowActions,
         onAPIError: @escaping (Error) -> Void, filesInspector: SplitFilesInspector) {
        self.viewModel = viewModel
        self.actions = actions
        self.onAPIError = onAPIError
        self.filesInspector = filesInspector
    }

    func actions(in list: AppSection, make: () -> SessionListRowActions) -> SessionListRowActions {
        guard list != .chats else { return actions }
        if let cached = sectionActions[list] { return cached }
        let made = make()
        sectionActions[list] = made
        return made
    }
}

extension EnvironmentValues {
    @Entry var sessionActions: SessionActionContext?
}
