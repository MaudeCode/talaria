import SwiftUI
import TalariaKit

extension EnvironmentValues {
    /// The Duo's tent pose holds (TAL-1460): running and waiting rows render as run cards.
    @Entry var sessionRowsMonitorRuns = false
    @Entry var sessionRowStyle = SessionRowStyle.regular
}

/// A session row as its List sees it (TAL-2399). The List reads row traits (insets, separator, background, swipe
/// actions, transition, identity) from the view `ForEach` hands it, and the `EquatableView` that lets an unchanged row
/// skip its body hides traits set inside it, so they sit here, outside `.equatable()`.
struct SessionListRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let row: SessionInteractiveRow

    var body: some View {
        row.equatable()
            .sidebarListRow()
            .id(row.session.id)
            .transition(SessionListMotion.sessionRowTransition(reduceMotion: reduceMotion))
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                row.sessionActions(placement: .leadingSwipe)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                row.sessionActions(placement: .trailingSwipe)
            }
    }
}

/// A list builds its rows in its own body and hands each to `ForEach` as a `SessionListRow`, so a list update re-runs
/// only the rows whose own inputs changed. Built inside a `ForEach` closure instead, the row's list reads could land on
/// the row itself and re-run it on every list change.
struct SessionInteractiveRow: View, Equatable {
    @Environment(\.sessionRowsMonitorRuns) private var monitorsRuns
    let viewModel: SessionListViewModel
    let session: SessionSummary
    let actions: SessionListRowActions
    let searchText: String
    private let state: State

    /// Everything the row shows from the list, read where the list builds the row. The body reads no list state of its
    /// own: an equatable row handed an equal value can miss a list change it observed in the same update. The style
    /// comes from the list too: SwiftUI cannot compare it in the environment, so reading it there re-runs every row
    /// whenever an ancestor's environment updates.
    private struct State: Equatable {
        var style: SessionRowStyle
        var isOpen: Bool
        var pendingChange: PendingResourceChange?
        var isMutating: Bool
        var canOpenBeside: Bool
        var canOpenInNewWindow: Bool
        var matchPreview: String?
        var isViewingCachedData: Bool
        var isSelectingSessions: Bool
        var isPicked: Bool
        var supportsBulkActions: Bool
        var isPerformingBulkAction: Bool
    }

    init(viewModel: SessionListViewModel, session: SessionSummary, selectedSessionID: String?,
         actions: SessionListRowActions, searchText: String = "", style: SessionRowStyle = .regular) {
        self.viewModel = viewModel
        self.session = session
        self.actions = actions
        self.searchText = searchText
        state = State(
            style: style,
            isOpen: session.sessionId == selectedSessionID,
            pendingChange: viewModel.pendingChange(for: session),
            isMutating: viewModel.isMutating(session),
            canOpenBeside: actions.openBeside(session) != nil,
            canOpenInNewWindow: actions.openInNewWindow(session) != nil,
            matchPreview: viewModel.contentMatchPreview(for: session, searchText: searchText),
            isViewingCachedData: viewModel.isViewingCachedData,
            isSelectingSessions: viewModel.isSelectingSessions,
            isPicked: viewModel.isSelectingSessions && viewModel.isSelected(session),
            supportsBulkActions: viewModel.supportsBulkActions,
            isPerformingBulkAction: viewModel.isPerformingBulkAction
        )
    }

    /// The rows a list shows, built in that list's body.
    static func rows(_ sessions: [SessionSummary], viewModel: SessionListViewModel, selectedSessionID: String?,
                     actions: SessionListRowActions, searchText: String, style: SessionRowStyle) -> [SessionInteractiveRow] {
        sessions.map {
            SessionInteractiveRow(viewModel: viewModel, session: $0, selectedSessionID: selectedSessionID, actions: actions,
                                  searchText: searchText, style: style)
        }
    }

    /// The actions are the list's handlers, stable for its lifetime; only whether this row opens beside the chat
    /// follows view state, and `state` carries it.
    nonisolated static func == (lhs: SessionInteractiveRow, rhs: SessionInteractiveRow) -> Bool {
        lhs.session == rhs.session && lhs.searchText == rhs.searchText && lhs.state == rhs.state
    }

    private var rowStyle: SessionRowStyle { state.style }

    var body: some View {
        #if DEBUG
        let _ = ChatBodyEvaluationRecorder.installed?("sessionRow:\(session.id)")
        #endif
        draggableRowContent
            // While picking chats the checkmarks carry selection, so the open chat stops reading as selected.
            .sidebarRow(isSelected: !state.isSelectingSessions && state.isOpen, isListRow: false, revealsSwipe: !state.isSelectingSessions)
            .contextMenu { contextMenuContent(includesSelection: canEnterSelection) }
            .accessibilityActions {
                rowMenu(placement: .menu).windowButtons
                if canEnterSelection, !selectionIsDisabled {
                    Button("Select Chats…") { viewModel.beginSelectingSessions() }
                }
            }
    }

    @ViewBuilder
    private var draggableRowContent: some View {
        if !state.isSelectingSessions, (rowStyle == .sidebar && state.canOpenBeside) || state.canOpenInNewWindow {
            rowContent.onDrag {
                actions.sidebarChatLifted(session)
                return SidebarChatDrag.provider(for: session, opensWindow: state.canOpenInNewWindow)
            }
        } else {
            rowContent
        }
    }

    /// Select is a row-only prefix; all session actions use the same menu placement as the chat.
    @ViewBuilder
    func contextMenuContent(includesSelection: Bool) -> some View {
        if !state.isSelectingSessions {
            if includesSelection {
                Button { viewModel.beginSelectingSessions() } label: {
                    Label("Select Chats…", systemImage: "checkmark.circle")
                }
                .disabled(selectionIsDisabled)
            }
            sessionActions(placement: .menu)
        }
    }

    private var canEnterSelection: Bool {
        rowStyle == .sidebar && state.supportsBulkActions && !state.isSelectingSessions
    }

    private var selectionIsDisabled: Bool { state.isViewingCachedData || state.isPerformingBulkAction }

    /// A run card keeps Stop beside the button that opens the chat, so VoiceOver reaches it and tapping it stops the
    /// run instead of opening the chat.
    @ViewBuilder
    private var rowContent: some View {
        if monitorsRuns, let runStatus = SessionRunMonitor.runStatus(for: session) {
            HStack(spacing: 12) {
                openButton(style: .monitor(runStatus))
                if !runStatus.isAwaitingUser {
                    stopButton
                }
            }
        } else {
            openButton(style: rowStyle)
        }
    }

    private func openButton(style: SessionRowStyle) -> some View {
        Button {
            if state.isSelectingSessions {
                viewModel.toggleSelection(session)
            } else {
                actions.open(session)
            }
        } label: {
            HStack(spacing: 12) {
                if state.isSelectingSessions {
                    Image(systemName: state.isPicked ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(isSelectable ? Color.accentColor : Color.secondary)
                        .accessibilityHidden(true)
                }
                SessionRowView(
                    session: session,
                    isViewingCachedData: state.isViewingCachedData,
                    matchPreview: state.matchPreview,
                    searchText: searchText,
                    pendingChange: state.pendingChange,
                    style: style
                )
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(state.isSelectingSessions && !isSelectable)
        .accessibilityAddTraits(state.isPicked ? .isSelected : [])
    }

    private var stopButton: some View {
        Button {
            actions.stopRun(session)
        } label: {
            Label("Stop", systemImage: "stop.fill")
                .font(AppFont.title3(weight: .semibold))
                .foregroundStyle(state.isSelectingSessions || state.isViewingCachedData ? Color.secondary : Color.red)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .tint(.red)
        .disabled(state.isSelectingSessions || state.isViewingCachedData)
        .accessibilityIdentifier("session-run-stop")
        .padding(.trailing, 12)
    }

    private var isSelectable: Bool {
        !state.isViewingCachedData && SessionRowActionPolicy.isBulkSelectable(session)
    }

    private func rowMenu(placement: SessionRowContextMenu.Placement) -> SessionRowContextMenu {
        SessionRowContextMenu(viewModel: viewModel, session: session, actions: actions, placement: placement,
            openBeside: rowStyle == .sidebar && !state.isSelectingSessions ? actions.openBeside(session) : nil,
            openInNewWindow: !state.isSelectingSessions ? actions.openInNewWindow(session) : nil,
            rowState: (state.pendingChange, state.isMutating))
    }

    @ViewBuilder
    func sessionActions(placement: SessionRowContextMenu.Placement) -> some View {
        if !state.isSelectingSessions {
            rowMenu(placement: placement)
        }
    }
}
