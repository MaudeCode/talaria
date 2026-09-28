import SwiftUI
import TalariaKit

struct KanbanBoardManagementView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: KanbanFeatureState
    @State private var editorMode: KanbanBoardEditorMode?
    @State private var pendingArchive: KanbanBoard?
    @State private var pendingActivation: KanbanBoard?

    var body: some View {
        List {
            if let mutation = model.boardMutationState {
                Section {
                    boardMutationStatus(mutation)
                }
            }

            Section {
                ForEach(model.boards, id: \.slug) { board in
                    boardRow(board)
                }
            } footer: {
                Text("Browsing a Board stays local to Talaria. Making a Board active changes shared server state.")
            }
        }
        .navigationTitle("Manage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { dismiss() }
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    model.dismissBoardMutationResult()
                    editorMode = .create
                } label: {
                    Label("Create", systemImage: "plus")
                }
                .disabled(!model.canManageBoards)
                .accessibilityHint(Text("Creating a Board does not make it active."))
            }
        }
        .sheet(item: $editorMode) { mode in
            NavigationStack {
                KanbanBoardEditorView(model: model, mode: mode)
            }
        }
        .alert(
            "Archive",
            isPresented: Binding(
                get: { pendingArchive != nil },
                set: { if !$0 { pendingArchive = nil } }
            ),
            presenting: pendingArchive
        ) { board in
            Button("Cancel", role: .cancel) { pendingArchive = nil }
            Button("Archive", role: .destructive) {
                pendingArchive = nil
                Task { await model.archiveBoard(slug: board.slug ?? "") }
            }
        } message: { _ in
            Text("Talaria cannot restore an archived Board in-app.")
        }
        .alert(
            "Make Active Board",
            isPresented: Binding(
                get: { pendingActivation != nil },
                set: { if !$0 { pendingActivation = nil } }
            ),
            presenting: pendingActivation
        ) { board in
            Button("Cancel", role: .cancel) { pendingActivation = nil }
            Button("Make Active Board") {
                pendingActivation = nil
                Task { await model.makeBoardActive(slug: board.slug ?? "") }
            }
        } message: { _ in
            Text("Making this Board active changes shared server state for other Hermes clients.")
        }
    }

    private func boardRow(_ board: KanbanBoard) -> some View {
        let presentation = KanbanBoardRowPresentation(
            board: board,
            selectedBoardSlug: model.selectedBoardSlug,
            sharedActiveBoardSlug: model.sharedActiveBoardSlug,
            canManageBoards: model.canManageBoards
        )

        return HStack(alignment: .top, spacing: 8) {
            boardBrowseControl(board, presentation: presentation)
            boardActionsMenu(board, presentation: presentation)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func boardBrowseControl(
        _ board: KanbanBoard,
        presentation: KanbanBoardRowPresentation
    ) -> some View {
        if let slug = presentation.browseSlug {
            Button {
                Task { await model.selectBoard(slug) }
            } label: {
                boardRowContent(board, presentation: presentation)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                Text(
                    KanbanBoardAccessibility.browseSummary(
                        board,
                        isActive: presentation.isActive
                    )
                )
            )
            .accessibilityHint(
                Text("Browsing a Board stays local to Talaria. Making a Board active changes shared server state.")
            )
        } else {
            boardRowContent(board, presentation: presentation)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(
                    presentation.isBrowsing ? .isSelected : AccessibilityTraits()
                )
        }
    }

    private func boardRowContent(
        _ board: KanbanBoard,
        presentation: KanbanBoardRowPresentation
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(board.icon ?? "▣")
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(board.name ?? board.slug ?? String(localized: "Board"))
                        .font(.headline)
                    if let slug = board.slug {
                        Text(slug)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if presentation.isBrowsing || presentation.isActive {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        boardStatusIndicators(presentation)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        boardStatusIndicators(presentation)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .labelStyle(KanbanBoardStatusLabelStyle())
            }

            if let description = board.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text(KanbanCountFormatter.cards(board.total ?? 0))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func boardStatusIndicators(_ presentation: KanbanBoardRowPresentation) -> some View {
        if presentation.isBrowsing {
            Label("Browsing", systemImage: "eye.fill")
        }
        if presentation.isActive {
            Label("Active", systemImage: "checkmark.circle.fill")
        }
    }

    private func boardActionsMenu(
        _ board: KanbanBoard,
        presentation: KanbanBoardRowPresentation
    ) -> some View {
        Menu {
            if presentation.actions.contains(.edit) {
                Button {
                    model.dismissBoardMutationResult()
                    editorMode = .edit(board)
                } label: {
                    Label("Edit", systemImage: KanbanBoardRowAction.edit.systemImage)
                }
            }
            if presentation.actions.contains(.makeActive) {
                Button {
                    pendingActivation = board
                } label: {
                    Label(
                        "Make Active Board",
                        systemImage: KanbanBoardRowAction.makeActive.systemImage
                    )
                }
            }
            if presentation.actions.contains(.archive) {
                Button(role: .destructive) {
                    pendingArchive = board
                } label: {
                    Label("Archive", systemImage: KanbanBoardRowAction.archive.systemImage)
                }
            }
        } label: {
            Label(
                KanbanBoardAccessibility.actionsLabel(board),
                systemImage: "ellipsis.circle"
            )
            .labelStyle(.iconOnly)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!presentation.mutationsAreEnabled || presentation.actions.isEmpty)
        .accessibilityLabel(Text(KanbanBoardAccessibility.actionsLabel(board)))
        .accessibilityHint(Text("Shows available Board management actions."))
    }

    private func boardMutationStatus(_ mutation: KanbanBoardMutationState) -> some View {
        HStack(spacing: 10) {
            if mutation.phase.isInFlight {
                ProgressView()
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(boardMutationAction(mutation.kind))
                    .font(.headline)
                Text(boardMutationPhase(mutation.phase))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if mutation.phase == .outcomeUncertain {
                Button("Check Result") {
                    Task { await model.checkBoardMutationResult() }
                }
            } else if !mutation.phase.isInFlight {
                Button {
                    model.dismissBoardMutationResult()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .accessibilityLabel(Text("Dismiss"))
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func boardMutationAction(_ kind: KanbanBoardMutationKind) -> LocalizedStringKey {
        switch kind {
        case .create: "Create"
        case .edit: "Edit"
        case .archive: "Archive"
        case .makeActive: "Make Active Board"
        }
    }

    private func boardMutationPhase(_ phase: KanbanCardMutationPhase) -> LocalizedStringKey {
        switch phase {
        case .updating: "Updating Board..."
        case .checkingResult: "Checking Result"
        case .succeeded: "Done"
        case .failed: "Failed"
        case .outcomeUncertain: "Outcome Uncertain"
        }
    }
}
