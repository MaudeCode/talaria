import SwiftUI
import TalariaKit

extension EnvironmentValues {
    /// The Duo's tent pose holds (TAL-1460): running and waiting rows render as run cards.
    @Entry var sessionRowsMonitorRuns = false
    @Entry var sessionRowStyle = SessionRowStyle.regular
}

struct SessionInteractiveRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sessionRowsMonitorRuns) private var monitorsRuns
    @Environment(\.sessionRowStyle) private var rowStyle
    let viewModel: SessionListViewModel
    let session: SessionSummary
    let selectedSessionID: String?
    let actions: SessionListRowActions
    var searchText = ""

    var body: some View {
        rowContent
            .id(session.id)
            // While picking chats the checkmarks carry selection, so the open chat stops reading as selected.
            .sidebarRow(isSelected: !viewModel.isSelectingSessions && session.sessionId == selectedSessionID)
            .transition(SessionListMotion.sessionRowTransition(reduceMotion: reduceMotion))
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                sessionActions(placement: .leadingSwipe)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                sessionActions(placement: .trailingSwipe)
            }
            .contextMenu {
                if !viewModel.isSelectingSessions {
                    if canEnterSelection {
                        Button { viewModel.beginSelectingSessions() } label: {
                            Label("Select Chats…", systemImage: "checkmark.circle")
                        }
                        .disabled(selectionIsDisabled)
                    }
                    sessionActions(placement: .menu)
                }
            }
            .accessibilityActions {
                if canEnterSelection, !selectionIsDisabled {
                    Button("Select Chats…") { viewModel.beginSelectingSessions() }
                }
            }
    }

    private var canEnterSelection: Bool {
        rowStyle == .sidebar && viewModel.supportsBulkActions && !viewModel.isSelectingSessions
    }

    private var selectionIsDisabled: Bool { viewModel.isViewingCachedData || viewModel.isPerformingBulkAction }

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
            if viewModel.isSelectingSessions {
                viewModel.toggleSelection(session)
            } else {
                actions.open(session)
            }
        } label: {
            HStack(spacing: 12) {
                if viewModel.isSelectingSessions {
                    Image(systemName: viewModel.isSelected(session) ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(isSelectable ? Color.accentColor : Color.secondary)
                        .accessibilityHidden(true)
                }
                SessionRowView(
                    session: session,
                    isViewingCachedData: viewModel.isViewingCachedData,
                    matchPreview: viewModel.contentMatchPreview(for: session, searchText: searchText),
                    searchText: searchText,
                    pendingChange: viewModel.pendingChange(for: session),
                    style: style
                )
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(viewModel.isSelectingSessions && !isSelectable)
        .accessibilityAddTraits(viewModel.isSelectingSessions && viewModel.isSelected(session) ? .isSelected : [])
    }

    private var stopButton: some View {
        Button {
            actions.stopRun(session)
        } label: {
            Label("Stop", systemImage: "stop.fill")
                .font(AppFont.title3(weight: .semibold))
                .foregroundStyle(viewModel.isSelectingSessions || viewModel.isViewingCachedData ? Color.secondary : Color.red)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .tint(.red)
        .disabled(viewModel.isSelectingSessions || viewModel.isViewingCachedData)
        .accessibilityIdentifier("session-run-stop")
        .padding(.trailing, 12)
    }

    private var isSelectable: Bool {
        !viewModel.isViewingCachedData && SessionRowActionPolicy.isBulkSelectable(session)
    }

    @ViewBuilder
    func sessionActions(placement: SessionRowContextMenu.Placement) -> some View {
        if !viewModel.isSelectingSessions {
            SessionRowContextMenu(viewModel: viewModel, session: session, actions: actions, placement: placement)
        }
    }
}
